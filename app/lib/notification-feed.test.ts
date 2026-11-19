import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationType } from "~/db/schema";
import { unreadBadge } from "~/components/notification-bell";
import {
  getFeed,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

/** Adds a Feed row directly; the Feed doesn't care how it was created. */
function addNotification(recipientUserId: number, minutesAgo: number, text = "Hello") {
  return db
    .insert(schema.notifications)
    .values({
      recipientUserId,
      type: NotificationType.RefundRequestRaised,
      text,
      href: "/settings",
      createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    })
    .returning()
    .get();
}

describe("the Notification Feed", () => {
  it("lists a person's Notifications newest first", () => {
    addNotification(base.user.id, 30, "older");
    addNotification(base.user.id, 5, "newer");
    addNotification(base.instructor.id, 1, "someone else's");

    const feed = getFeed(db, base.user.id, 20, NOW);

    expect(feed.items.map((i) => i.text)).toEqual(["newer", "older"]);
    expect(feed.total).toBe(2);
    expect(feed.unread).toBe(2);
    expect(feed.items[0]).toMatchObject({ href: "/settings", read: false });
  });

  it("returns 20 at a time and reports the total", () => {
    for (let i = 0; i < 45; i++) addNotification(base.user.id, i);

    const first = getFeed(db, base.user.id, 20, NOW);
    expect(first.items).toHaveLength(20);
    expect(first.total).toBe(45);

    const older = getFeed(db, base.user.id, 40, NOW);
    expect(older.items.slice(0, 20)).toEqual(first.items);
    expect(older.items).toHaveLength(40);
  });

  it("is empty for someone with no Notifications", () => {
    expect(getFeed(db, base.user.id, 20, NOW)).toEqual({ items: [], total: 0, unread: 0 });
  });

  it("marks a clicked Notification read and returns its link", () => {
    const n = addNotification(base.user.id, 1);

    expect(markNotificationRead(db, base.user.id, n.id, NOW)).toBe("/settings");

    expect(getUnreadCount(db, base.user.id, NOW)).toBe(0);
    expect(getFeed(db, base.user.id, 20, NOW).items[0].read).toBe(true);
  });

  it("keeps the first read time when clicked again", () => {
    const n = addNotification(base.user.id, 1);
    markNotificationRead(db, base.user.id, n.id, NOW);
    markNotificationRead(db, base.user.id, n.id, new Date(NOW.getTime() + 60_000));

    const row = db.select().from(schema.notifications).get();
    expect(row?.readAt).toBe(NOW.toISOString());
  });

  it("won't mark someone else's Notification read", () => {
    const theirs = addNotification(base.instructor.id, 1);

    expect(markNotificationRead(db, base.user.id, theirs.id, NOW)).toBeNull();
    expect(getUnreadCount(db, base.instructor.id, NOW)).toBe(1);
  });

  it("marks all of a person's Notifications read, and only theirs", () => {
    addNotification(base.user.id, 2);
    addNotification(base.user.id, 1);
    addNotification(base.instructor.id, 1);

    markAllNotificationsRead(db, base.user.id, NOW);

    expect(getUnreadCount(db, base.user.id, NOW)).toBe(0);
    expect(getUnreadCount(db, base.instructor.id, NOW)).toBe(1);
  });
});

describe("the bell's badge", () => {
  it.each([
    [0, null],
    [1, "1"],
    [9, "9"],
    [10, "9+"],
    [250, "9+"],
  ])("shows %i unread as %s", (count, label) => {
    expect(unreadBadge(count)).toBe(label);
  });
});
