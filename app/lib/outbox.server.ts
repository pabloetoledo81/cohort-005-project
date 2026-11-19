import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "~/db/types";
import {
  DeliveryStatus,
  notificationDeliveries,
  notifications,
} from "~/db/schema";
import { MailSendError, type MailTransport } from "~/lib/mailer.server";
import { streamFor } from "~/lib/notification-types.server";
import { unsubscribeHeaders } from "~/lib/unsubscribe.server";

// ─── The email outbox ───
// Sends the email Deliveries that are due. An in-process poller calls this
// every few seconds (docs/adr/0013). Delivery is at least once: a Delivery is
// marked sent only after the transport accepts it, so a crash between the two
// sends it again. Temporary failures are retried with backoff; permanent ones
// and the last attempt mark the Delivery failed.

export const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 50;

export async function processDueDeliveries(
  db: Db,
  transport: MailTransport,
  now: Date
): Promise<number> {
  const due = db
    .select({
      delivery: notificationDeliveries,
      type: notifications.type,
      recipientUserId: notifications.recipientUserId,
    })
    .from(notificationDeliveries)
    .innerJoin(
      notifications,
      eq(notificationDeliveries.notificationId, notifications.id)
    )
    .where(
      and(
        eq(notificationDeliveries.status, DeliveryStatus.Pending),
        lte(notificationDeliveries.nextAttemptAt, now.toISOString())
      )
    )
    .orderBy(
      asc(notificationDeliveries.nextAttemptAt),
      asc(notificationDeliveries.id)
    )
    .limit(BATCH_SIZE)
    .all();

  for (const { delivery, type, recipientUserId } of due) {
    const attempts = delivery.attempts + 1;

    try {
      const { messageId } = await transport.send({
        to: delivery.toAddress,
        subject: delivery.subject,
        body: delivery.body,
        stream: streamFor(type),
        // RFC 8058 one-click unsubscribe, on optional emails only.
        headers: delivery.mandatory
          ? undefined
          : unsubscribeHeaders(recipientUserId, type),
      });

      db.update(notificationDeliveries)
        .set({
          status: DeliveryStatus.Sent,
          attempts,
          providerMessageId: messageId,
          sentAt: new Date().toISOString(),
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, delivery.id))
        .run();
    } catch (error) {
      recordFailure(db, delivery.id, attempts, error, now);
    }
  }

  return due.length;
}

// ─── Retries ───
// About five attempts over roughly an hour: the delay before attempt n + 1 is
// RETRY_DELAYS_MINUTES[n - 1]. Attempts land at 0, 1, 6, 21 and 61 minutes.
export const RETRY_DELAYS_MINUTES = [1, 5, 15, 40];
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

function recordFailure(
  db: Db,
  deliveryId: number,
  attempts: number,
  error: unknown,
  now: Date
) {
  const message = error instanceof Error ? error.message : String(error);
  const permanent = error instanceof MailSendError && error.permanent;

  if (!permanent && attempts < MAX_ATTEMPTS) {
    const delayMs = RETRY_DELAYS_MINUTES[attempts - 1] * 60_000;
    db.update(notificationDeliveries)
      .set({
        attempts,
        lastError: message,
        nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
    return;
  }

  // Final: the email is given up on. Nobody is alerted in v1, and the
  // Notification in the Feed is unaffected.
  db.update(notificationDeliveries)
    .set({ status: DeliveryStatus.Failed, attempts, lastError: message })
    .where(eq(notificationDeliveries.id, deliveryId))
    .run();
  console.error(
    `Email Delivery ${deliveryId} failed after ${attempts} attempt(s)` +
      `${permanent ? " (permanent)" : ""}: ${message}`
  );
}

/**
 * Starts polling the outbox. Runs never overlap: a slow batch delays the next
 * poll instead of sending the same Delivery twice in parallel.
 */
export function startOutboxPoller(
  db: Db,
  transport: () => MailTransport
): () => void {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDueDeliveries(db, transport(), new Date());
    } catch (error) {
      console.error("The email outbox poller failed:", error);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
