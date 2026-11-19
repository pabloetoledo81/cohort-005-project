import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { DeliveryChannel, DeliveryStatus, NotificationType } from "~/db/schema";
import {
  BATCH_SIZE,
  CLEANUP_INTERVAL_MS,
  deleteExpiredBatch,
  deleteExpiredNotifications,
  startRetentionTimer,
} from "./retention.server";
import { getFeed } from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function addNotification(ageDays: number, opts: { read?: boolean } = {}) {
  return db
    .insert(schema.notifications)
    .values({
      recipientUserId: base.user.id,
      type: NotificationType.RefundRequestRaised,
      text: `${ageDays} days old`,
      href: "/settings",
      createdAt: daysAgo(ageDays),
      readAt: opts.read ? daysAgo(ageDays) : null,
    })
    .returning()
    .get().id;
}

function addDelivery(notificationId: number, status: DeliveryStatus) {
  db.insert(schema.notificationDeliveries)
    .values({
      notificationId,
      channel: DeliveryChannel.Email,
      toAddress: "test@example.com",
      subject: "s",
      body: "b",
      mandatory: true,
      status,
      nextAttemptAt: NOW.toISOString(),
    })
    .run();
}

const notificationIds = () =>
  db.select().from(schema.notifications).all().map((n) => n.id);
const deliveryCount = () => db.select().from(schema.notificationDeliveries).all().length;

describe("retention", () => {
  it("deletes Notifications older than 180 days, read or unread, with their Deliveries", async () => {
    const oldUnread = addNotification(181);
    const oldRead = addNotification(200, { read: true });
    addDelivery(oldUnread, DeliveryStatus.Sent);
    addDelivery(oldRead, DeliveryStatus.Failed);
    const recent = addNotification(179);
    addDelivery(recent, DeliveryStatus.Sent);

    await deleteExpiredNotifications(db, NOW);

    expect(notificationIds()).toEqual([recent]);
    expect(deliveryCount()).toBe(1);
  });

  it("never deletes a pending Delivery, or its Notification", async () => {
    const waiting = addNotification(181);
    addDelivery(waiting, DeliveryStatus.Pending);

    await deleteExpiredNotifications(db, NOW);

    expect(notificationIds()).toEqual([waiting]);
    expect(deliveryCount()).toBe(1);
  });

  it("deletes in batches and can be re-run after stopping partway", async () => {
    for (let i = 0; i < BATCH_SIZE + 20; i++) addNotification(190);

    // One batch, then "crash".
    expect(deleteExpiredBatch(db, NOW)).toBe(BATCH_SIZE);
    expect(notificationIds()).toHaveLength(20);

    await deleteExpiredNotifications(db, NOW);
    expect(notificationIds()).toHaveLength(0);
    // Running again finds nothing to do.
    expect(await deleteExpiredNotifications(db, NOW)).toBe(0);
  });

  it("makes 'load older' end at the 180-day boundary", async () => {
    addNotification(10);
    addNotification(250);

    await deleteExpiredNotifications(db, NOW);

    expect(getFeed(db, base.user.id, 20, NOW)).toMatchObject({ total: 1 });
  });
});

describe("the retention timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans up once at startup and then every 24 hours", async () => {
    vi.useFakeTimers({ now: NOW });
    addNotification(400);

    const stop = startRetentionTimer(db);
    // Let the startup run finish (it yields between batches).
    await vi.advanceTimersByTimeAsync(1000);
    expect(notificationIds()).toEqual([]);

    // Something expires during the day: the next daily run removes it.
    addNotification(400);
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS - 2000);
    expect(notificationIds()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(notificationIds()).toEqual([]);

    stop();
  });
});
