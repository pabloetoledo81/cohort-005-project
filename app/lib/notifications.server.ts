import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationType,
  notificationDeliveries,
  notifications,
  users,
} from "~/db/schema";
import {
  notificationTypes,
  type NotificationPayloads,
  type RegisteredType,
} from "~/lib/notification-types.server";
import { hasOptedOut } from "~/lib/email-opt-outs.server";
import { unsubscribeUrl } from "~/lib/unsubscribe.server";

// ─── Notifications ───
// Creating a Notification writes its Feed row and, for a Type with email, its
// pending email Delivery. Call it with the transaction that makes the change
// the Notification is about, so both commit or neither does. The outbox
// poller sends the email later (docs/adr/0013).

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

export type Notified = { notificationId: number; deliveryId: number | null };

export function notify<T extends RegisteredType>(
  db: Queryable,
  type: T,
  payload: NotificationPayloads[T],
  now: Date
): Notified {
  const definition = notificationTypes[type];
  const rendered = definition.render(payload);
  const createdAt = now.toISOString();

  const notification = db
    .insert(notifications)
    .values({
      recipientUserId: rendered.recipientUserId,
      type,
      text: rendered.text,
      href: rendered.href,
      commentId: rendered.commentId ?? null,
      refundRequestId: rendered.refundRequestId ?? null,
      createdAt,
    })
    .returning({ id: notifications.id })
    .get();

  if (!rendered.email) {
    return { notificationId: notification.id, deliveryId: null };
  }

  // Checked now, when the Notification is created. An email already in the
  // outbox still goes, and opting back in resends nothing.
  if (
    !definition.mandatory &&
    hasOptedOut(db, rendered.recipientUserId, type)
  ) {
    return { notificationId: notification.id, deliveryId: null };
  }

  // The address is looked up now, not at send time.
  const recipient = db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, rendered.recipientUserId))
    .get();
  const toAddress = recipient?.email.trim() ?? "";

  if (toAddress === "") {
    console.warn(
      `Notification ${notification.id} (${type}) has no email Delivery: user ${rendered.recipientUserId} has no email address.`
    );
    return { notificationId: notification.id, deliveryId: null };
  }

  const delivery = db
    .insert(notificationDeliveries)
    .values({
      notificationId: notification.id,
      channel: DeliveryChannel.Email,
      toAddress,
      subject: rendered.email.subject,
      body: definition.mandatory
        ? rendered.email.body
        : withUnsubscribeFooter(
            rendered.email.body,
            rendered.recipientUserId,
            type
          ),
      mandatory: definition.mandatory,
      status: DeliveryStatus.Pending,
      nextAttemptAt: createdAt,
      createdAt,
    })
    .returning({ id: notificationDeliveries.id })
    .get();

  return { notificationId: notification.id, deliveryId: delivery.id };
}

/** Every optional email ends with a one-click way to turn that Type off. */
function withUnsubscribeFooter(
  body: string,
  userId: number,
  type: NotificationType
) {
  return `${body}\n\n---\nTurn off these emails: ${unsubscribeUrl(userId, type)}`;
}

// ─── The Notification Feed ───
// A person only ever sees and marks their own Notifications: every query is
// scoped to the recipient.

export const FEED_PAGE_SIZE = 20;

export type FeedItem = {
  id: number;
  type: NotificationType;
  text: string;
  href: string;
  createdAt: string;
  read: boolean;
};

export function getUnreadCount(db: Queryable, userId: number): number {
  return (
    db
      .select({ count: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientUserId, userId),
          isNull(notifications.readAt)
        )
      )
      .get()?.count ?? 0
  );
}

/** The newest `limit` Notifications, plus how many there are in total. */
export function getFeed(
  db: Queryable,
  userId: number,
  limit: number
): { items: FeedItem[]; total: number; unread: number } {
  const items = db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientUserId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .all()
    .map((n) => ({
      id: n.id,
      type: n.type,
      text: n.text,
      href: n.href,
      createdAt: n.createdAt,
      read: n.readAt !== null,
    }));

  const total =
    db
      .select({ count: count() })
      .from(notifications)
      .where(eq(notifications.recipientUserId, userId))
      .get()?.count ?? 0;

  return { items, total, unread: getUnreadCount(db, userId) };
}

/**
 * Marks one of the person's own Notifications read and returns where it
 * links, or null when it isn't theirs (or doesn't exist).
 */
export function markNotificationRead(
  db: Queryable,
  userId: number,
  notificationId: number,
  now: Date
): string | null {
  const notification = db
    .select({ href: notifications.href, readAt: notifications.readAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientUserId, userId)
      )
    )
    .get();

  if (!notification) return null;

  if (notification.readAt === null) {
    db.update(notifications)
      .set({ readAt: now.toISOString() })
      .where(eq(notifications.id, notificationId))
      .run();
  }

  return notification.href;
}

export function markAllNotificationsRead(
  db: Queryable,
  userId: number,
  now: Date
): void {
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt)
      )
    )
    .run();
}
