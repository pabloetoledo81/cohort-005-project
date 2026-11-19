import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  DeliveryStatus,
  NotificationType,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";

// The refund emails, moved onto Notifications: each refund change writes a
// Feed row and a pending email Delivery in the same transaction.

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let platformAdminId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  platformAdminId = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get().id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buyForSelf(userId = base.user.id) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: new Date(2026, 9, 3).toISOString(),
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeat(userId = base.user.id) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: new Date(2026, 9, 3).toISOString(),
    })
    .returning()
    .get();
  db.insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code: `SEAT-${purchase.id}`,
      purchaseId: purchase.id,
    })
    .run();
  return purchase;
}

function raise(purchaseId: number) {
  const result = raiseRefundRequest(
    db,
    purchaseId,
    base.user.id,
    "It was not what I expected.",
    NOW
  );
  if (!result.ok) throw new Error(result.error);
  return result.refundRequestId;
}

function allNotifications() {
  return db.select().from(schema.notifications).all();
}

function allDeliveries() {
  return db.select().from(schema.notificationDeliveries).all();
}

describe("raising a Refund Request", () => {
  it("notifies the buyer on the Feed and by email", () => {
    const purchase = buyForSelf();
    const id = raise(purchase.id);

    const [notification] = allNotifications();
    expect(allNotifications()).toHaveLength(1);
    expect(notification).toMatchObject({
      recipientUserId: base.user.id,
      type: NotificationType.RefundRequestRaised,
      text: "We received your refund request for Test Course",
      href: "/settings",
      refundRequestId: id,
      readAt: null,
    });

    const [delivery] = allDeliveries();
    expect(allDeliveries()).toHaveLength(1);
    expect(delivery).toMatchObject({
      notificationId: notification.id,
      channel: schema.DeliveryChannel.Email,
      toAddress: "test@example.com",
      subject: "Refund requested — Test Course",
      mandatory: true,
      status: DeliveryStatus.Pending,
      attempts: 0,
      nextAttemptAt: NOW.toISOString(),
    });
    expect(delivery.body).toContain("$79.00, the amount you paid");
    expect(delivery.body).toContain("We'll let you know once it's been decided.");
    expect(delivery.body).not.toContain("email you again");
    // Mandatory: no unsubscribe link.
    expect(delivery.body).not.toContain("Turn off these emails");
    expect(delivery.body).not.toContain("/unsubscribe/");
  });

  it("links a Team Licence's Notification to the team page", () => {
    const purchase = buySeat();
    raise(purchase.id);

    expect(allNotifications()[0].href).toBe("/team");
  });

  it("writes nothing when the Refund Request is refused", () => {
    const purchase = buyForSelf();
    raise(purchase.id);

    const second = raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Asking again, just in case.",
      NOW
    );

    expect(second.ok).toBe(false);
    expect(allNotifications()).toHaveLength(1);
  });

  it("keeps no Refund Request when its Notification can't be written", () => {
    const purchase = buyForSelf();
    db.$client.exec("DROP TABLE notification_deliveries");

    expect(() =>
      raiseRefundRequest(db, purchase.id, base.user.id, "Not for me.", NOW)
    ).toThrow();

    expect(db.select().from(schema.refunds).all()).toHaveLength(0);
    expect(allNotifications()).toHaveLength(0);
  });

  it("writes the Feed item but no email when the buyer has no address", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.update(schema.users)
      .set({ email: "" })
      .where(eq(schema.users.id, base.user.id))
      .run();
    const purchase = buyForSelf();

    raise(purchase.id);

    expect(allNotifications()).toHaveLength(1);
    expect(allDeliveries()).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("deciding a Refund Request", () => {
  it("notifies the buyer of an approval, with the new wording and the note", () => {
    const purchase = buyForSelf();
    const id = raise(purchase.id);

    approveRefundRequest(db, id, platformAdminId, "Sorry it didn't work out.", NOW);

    const notification = allNotifications()[1];
    expect(notification).toMatchObject({
      type: NotificationType.RefundRequestApproved,
      text: "Your refund request for Test Course was approved",
      href: "/settings",
      refundRequestId: id,
    });
    // The note goes in the email only.
    expect(notification.text).not.toContain("Sorry");

    const delivery = allDeliveries()[1];
    expect(delivery.subject).toBe("Refund approved — Test Course");
    expect(delivery.body).toContain(
      "Your refund of $79.00 has been approved. We'll let you know as soon as the money has been sent."
    );
    expect(delivery.body).not.toContain("on its way back");
    expect(delivery.body).toContain("Sorry it didn't work out.");
    expect(delivery.mandatory).toBe(true);
  });

  it("notifies the buyer of a decline, with the note", () => {
    const purchase = buyForSelf();
    const id = raise(purchase.id);

    declineRefundRequest(db, id, platformAdminId, "You finished the course.", NOW);

    const notification = allNotifications()[1];
    expect(notification).toMatchObject({
      type: NotificationType.RefundRequestDeclined,
      text: "Your refund request for Test Course was declined",
    });
    const delivery = allDeliveries()[1];
    expect(delivery.subject).toBe("Refund declined — Test Course");
    expect(delivery.body).toContain("You finished the course.");
  });

  it("writes nothing for a decision that loses the race", () => {
    const purchase = buyForSelf();
    const id = raise(purchase.id);
    approveRefundRequest(db, id, platformAdminId, null, NOW);

    declineRefundRequest(db, id, platformAdminId, "Too late.", NOW);

    expect(allNotifications().map((n) => n.type)).toEqual([
      NotificationType.RefundRequestRaised,
      NotificationType.RefundRequestApproved,
    ]);
    expect(
      db.select().from(schema.refunds).get()?.status
    ).toBe(RefundStatus.Approved);
  });
});
