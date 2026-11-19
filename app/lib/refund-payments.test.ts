import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus, UserRole } from "~/db/schema";
import {
  approveRefundRequest,
  checkRefundRequest,
  listRefundRequestsForBuyer,
  listRefundRequestsForReview,
  payRefund,
  raiseRefundRequest,
  REFUND_STUCK_AFTER_MS,
  retryRefund,
} from "./refunds.server";
import {
  SIMULATED_FAILURE_REASON,
  SimulatedRefundOutcome,
  simulatedPaymentProvider,
  type PaymentProvider,
} from "./payments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let adminId: number;
let lessonId: number;

const succeed = simulatedPaymentProvider(SimulatedRefundOutcome.Succeed);
const fail = simulatedPaymentProvider(SimulatedRefundOutcome.Fail);

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  adminId = db
    .insert(schema.users)
    .values({ name: "Pat", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get().id;
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "One", position: 1 })
    .returning()
    .get().id;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function buyForSelf() {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: new Date(2026, 9, 3).toISOString(),
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeats() {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 15800,
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
  const result = raiseRefundRequest(db, purchaseId, base.user.id, "Not for me.", NOW);
  if (!result.ok) throw new Error(result.error);
  return result.refundRequestId;
}

function approve(id: number, amount: number | null = null, note: string | null = null) {
  const result = approveRefundRequest(db, id, adminId, amount, note, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.refundId;
}

function refund(id: number) {
  const row = db.select().from(schema.refunds).where(eq(schema.refunds.id, id)).get();
  if (!row) throw new Error(`No Refund ${id}`);
  return row;
}

const isEnrolled = () =>
  db.select().from(schema.enrollments).all().some((e) => e.userId === base.user.id);

describe("the approved amount", () => {
  it("is the full amount paid by default", () => {
    const refundId = approve(raise(buyForSelf().id));
    expect(refund(refundId)).toMatchObject({
      approvedAmount: 7900,
      status: RefundStatus.Pending,
      attempts: 0,
    });
  });

  it("can be less for an Individual Purchase, with a note", () => {
    const refundId = approve(raise(buyForSelf().id), 4000, "You watched half.");
    expect(refund(refundId).approvedAmount).toBe(4000);
  });

  it("still ends the Enrollment for a Partial Refund", () => {
    approve(raise(buyForSelf().id), 4000, "You watched half.");
    expect(isEnrolled()).toBe(false);
  });

  it("needs a note for a Partial Refund", () => {
    const id = raise(buyForSelf().id);
    expect(approveRefundRequest(db, id, adminId, 4000, "  ", NOW)).toMatchObject({
      ok: false,
      status: 400,
      error: "Write the buyer a note saying why the refund is partial.",
    });
  });

  it.each([0, -100])("must be more than nothing (%i)", (amount) => {
    const id = raise(buyForSelf().id);
    expect(approveRefundRequest(db, id, adminId, amount, "x", NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("can't be more than was paid", () => {
    const id = raise(buyForSelf().id);
    expect(approveRefundRequest(db, id, adminId, 7901, null, NOW)).toMatchObject({
      ok: false,
      status: 400,
      error: "A refund can't be more than the $79.00 that was paid.",
    });
  });

  it("leaves the request Open when the amount is refused", () => {
    const id = raise(buyForSelf().id);
    approveRefundRequest(db, id, adminId, 0, null, NOW);
    expect(db.select().from(schema.refundRequests).get()?.status).toBe("open");
    expect(db.select().from(schema.refunds).all()).toHaveLength(0);
    expect(isEnrolled()).toBe(true);
  });

  it("is always the full amount for a Team Licence", () => {
    const refundId = approve(raise(buySeats().id));
    expect(refund(refundId).approvedAmount).toBe(15800);
  });

  it("can't be changed for a Team Licence", () => {
    const id = raise(buySeats().id);
    expect(approveRefundRequest(db, id, adminId, 5000, "Half?", NOW)).toMatchObject({
      ok: false,
      error: "A Team Licence is always refunded in full.",
    });
  });
});

describe("sending a Refund", () => {
  it("issues it when the provider succeeds", async () => {
    const refundId = approve(raise(buyForSelf().id));

    expect(await payRefund(db, succeed, refundId, NOW)).toEqual({
      ok: true,
      status: RefundStatus.Issued,
    });
    expect(refund(refundId)).toMatchObject({
      status: RefundStatus.Issued,
      providerReference: `sim_refund_${refundId}`,
      attempts: 1,
      failureReason: null,
    });
    expect(refund(refundId).issuedAt).not.toBeNull();
  });

  it("sends the whole approved amount, keyed by the Refund", async () => {
    const purchase = buyForSelf();
    const refundId = approve(raise(purchase.id), 4000, "Half.");
    const calls: unknown[] = [];
    const recording: PaymentProvider = {
      async refund(payment) {
        calls.push(payment);
        return { status: "issued", providerReference: "ref" };
      },
    };

    await payRefund(db, recording, refundId, NOW);

    expect(calls).toEqual([{ refundId, purchaseId: purchase.id, amount: 4000 }]);
  });

  it("records a failure and its reason", async () => {
    const refundId = approve(raise(buyForSelf().id));

    await payRefund(db, fail, refundId, NOW);

    expect(refund(refundId)).toMatchObject({
      status: RefundStatus.Failed,
      failureReason: SIMULATED_FAILURE_REASON,
    });
  });

  it("keeps only the first line of a thrown error, trimmed", async () => {
    const refundId = approve(raise(buyForSelf().id));
    const noisy: PaymentProvider = {
      async refund() {
        throw new Error(`${"x".repeat(500)}
    at internal (secret.ts:1:1)`);
      },
    };

    await payRefund(db, noisy, refundId, NOW);

    const reason = refund(refundId).failureReason ?? "";
    expect(reason).not.toContain("secret.ts");
    expect(reason.length).toBeLessThan(400);
  });

  it("treats a provider that throws as a failure", async () => {
    const refundId = approve(raise(buyForSelf().id));
    const broken: PaymentProvider = {
      async refund() {
        throw new Error("connection reset");
      },
    };

    await payRefund(db, broken, refundId, NOW);

    expect(refund(refundId)).toMatchObject({
      status: RefundStatus.Failed,
      failureReason: "The payment provider couldn't be reached: connection reset",
    });
  });

  it("won't send the same Refund twice", async () => {
    const refundId = approve(raise(buyForSelf().id));
    await payRefund(db, succeed, refundId, NOW);

    expect(await payRefund(db, succeed, refundId, NOW)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(refund(refundId).attempts).toBe(1);
  });

  it("doesn't give back access when it fails", async () => {
    const refundId = approve(raise(buyForSelf().id));
    await payRefund(db, fail, refundId, NOW);
    expect(isEnrolled()).toBe(false);
  });
});

describe("retrying a Refund", () => {
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  it("sends a Failed Refund again, for the same amount", async () => {
    const refundId = approve(raise(buyForSelf().id), 4000, "Half.");
    await payRefund(db, fail, refundId, NOW);

    expect(await retryRefund(db, succeed, refundId, later(1000))).toEqual({
      ok: true,
      status: RefundStatus.Issued,
    });
    expect(refund(refundId)).toMatchObject({
      status: RefundStatus.Issued,
      approvedAmount: 4000,
      attempts: 2,
      failureReason: null,
    });
    // Still one Refund Request and one Refund.
    expect(db.select().from(schema.refundRequests).all()).toHaveLength(1);
    expect(db.select().from(schema.refunds).all()).toHaveLength(1);
  });

  it("can fail again", async () => {
    const refundId = approve(raise(buyForSelf().id));
    await payRefund(db, fail, refundId, NOW);
    await retryRefund(db, fail, refundId, later(1000));
    expect(refund(refundId)).toMatchObject({ status: RefundStatus.Failed, attempts: 2 });
  });

  it("refuses an Issued Refund", async () => {
    const refundId = approve(raise(buyForSelf().id));
    await payRefund(db, succeed, refundId, NOW);
    expect(await retryRefund(db, succeed, refundId, later(1000))).toMatchObject({
      ok: false,
      status: 409,
      error: "This refund has already been issued.",
    });
  });

  it("refuses a Pending Refund that is still being sent", async () => {
    const refundId = approve(raise(buyForSelf().id));
    db.update(schema.refunds)
      .set({ lastAttemptAt: NOW.toISOString() })
      .where(eq(schema.refunds.id, refundId))
      .run();

    expect(
      await retryRefund(db, succeed, refundId, later(REFUND_STUCK_AFTER_MS - 1000))
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("recovers a Pending Refund left stuck mid-attempt", async () => {
    const refundId = approve(raise(buyForSelf().id));
    db.update(schema.refunds)
      .set({ lastAttemptAt: NOW.toISOString(), attempts: 1 })
      .where(eq(schema.refunds.id, refundId))
      .run();

    const result = await retryRefund(db, succeed, refundId, later(REFUND_STUCK_AFTER_MS));

    expect(result).toEqual({ ok: true, status: RefundStatus.Issued });
  });

  it("ignores a slow attempt that a Retry overtook", async () => {
    const refundId = approve(raise(buyForSelf().id));

    // The first attempt hangs until released.
    let release: () => void = () => {};
    const slow: PaymentProvider = {
      refund: () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "issued", providerReference: "slow" });
        }),
    };
    const first = payRefund(db, slow, refundId, NOW);

    // Long enough later to count as stuck, a Platform Admin retries.
    const retried = await retryRefund(db, succeed, refundId, later(REFUND_STUCK_AFTER_MS));
    expect(retried).toEqual({ ok: true, status: RefundStatus.Issued });

    release();
    expect(await first).toMatchObject({ ok: false, status: 409 });

    expect(refund(refundId)).toMatchObject({
      status: RefundStatus.Issued,
      providerReference: `sim_refund_${refundId}`,
      attempts: 2,
    });
    const issued = db
      .select()
      .from(schema.notifications)
      .all()
      .filter((n) => n.type === schema.NotificationType.RefundIssued);
    expect(issued).toHaveLength(1);
  });

  it("recovers a Pending Refund that was never attempted", async () => {
    // The process died between approval and the first attempt.
    const refundId = approve(raise(buyForSelf().id));
    expect(
      await retryRefund(db, succeed, refundId, later(REFUND_STUCK_AFTER_MS))
    ).toEqual({ ok: true, status: RefundStatus.Issued });
  });

  it("is offered to the Platform Admin only when allowed", async () => {
    const refundId = approve(raise(buyForSelf().id));
    await payRefund(db, fail, refundId, NOW);

    const [reviewed] = listRefundRequestsForReview(db, schema.RefundRequestStatus.Approved, NOW);
    expect(reviewed.refund).toMatchObject({
      status: RefundStatus.Failed,
      failureReason: SIMULATED_FAILURE_REASON,
      canRetry: true,
    });

    await retryRefund(db, succeed, refundId, later(1000));
    const [after] = listRefundRequestsForReview(db, schema.RefundRequestStatus.Approved, NOW);
    expect(after.refund?.canRetry).toBe(false);
  });
});

describe("what the buyer sees", () => {
  it("shows the Refund's state and amount, never the failure reason", async () => {
    const refundId = approve(raise(buyForSelf().id), 4000, "Half.");
    await payRefund(db, fail, refundId, NOW);

    const [mine] = listRefundRequestsForBuyer(db, base.user.id);

    expect(mine.status).toBe("approved");
    expect(mine.refund).toEqual({ status: RefundStatus.Failed, approvedAmount: 4000 });
    expect(JSON.stringify(mine)).not.toContain(SIMULATED_FAILURE_REASON);
  });
});

describe("the payment simulator", () => {
  it("refuses to run in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => simulatedPaymentProvider(SimulatedRefundOutcome.Succeed)).toThrow(
      /won't run in production/
    );
  });

  it("runs in production only when explicitly allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_PAYMENT_SIMULATOR", "true");
    expect(() => simulatedPaymentProvider(SimulatedRefundOutcome.Succeed)).not.toThrow();
  });
});

describe("the Watch Limit", () => {
  function watch(seconds: number) {
    db.insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId,
        eventType: "progress",
        positionSeconds: seconds,
      })
      .run();
  }

  it("allows a buyer just under two hours", () => {
    const purchase = buyForSelf();
    watch(2 * 60 * 60 - 1);
    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW).ok).toBe(true);
  });

  it("refuses a buyer at two hours", () => {
    const purchase = buyForSelf();
    watch(2 * 60 * 60);
    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("Refund issued and Refund failed Notifications", () => {
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  function refundNotifications() {
    return db
      .select()
      .from(schema.notifications)
      .all()
      .filter(
        (n) =>
          n.type === schema.NotificationType.RefundIssued ||
          n.type === schema.NotificationType.RefundFailed
      );
  }

  function emailFor(notificationId: number) {
    return db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.notificationId, notificationId))
      .get();
  }

  it("tells the buyer once the Refund is issued, on the Feed and by email", async () => {
    const id = raise(buyForSelf().id);
    const refundId = approve(id);

    await payRefund(db, succeed, refundId, NOW);

    const [issued] = refundNotifications();
    expect(refundNotifications()).toHaveLength(1);
    expect(issued).toMatchObject({
      recipientUserId: base.user.id,
      type: schema.NotificationType.RefundIssued,
      text: "Your refund of $79.00 for Test Course has been sent",
      href: "/settings",
      refundRequestId: id,
    });
    expect(emailFor(issued.id)).toMatchObject({
      toAddress: "test@example.com",
      subject: "Refund sent — Test Course",
      mandatory: true,
    });
    expect(emailFor(issued.id)?.body).toContain(
      'We\'ve sent your refund of $79.00 for "Test Course".'
    );
  });

  it("tells the buyer when it fails, without the provider's reason", async () => {
    const refundId = approve(raise(buyForSelf().id));

    await payRefund(db, fail, refundId, NOW);

    const [failed] = refundNotifications();
    expect(failed).toMatchObject({
      type: schema.NotificationType.RefundFailed,
      text: "We couldn't send your refund for Test Course; we're on it",
    });
    const email = emailFor(failed.id);
    if (!email) throw new Error("No email for the Refund failed Notification");
    expect(email.subject).toBe("We couldn't send your refund — Test Course");
    expect(email.body).toContain("You don't need to do anything");
    expect(failed.text).not.toContain(SIMULATED_FAILURE_REASON);
    expect(email.body).not.toContain(SIMULATED_FAILURE_REASON);
    // Mandatory: no unsubscribe link.
    expect(email.body).not.toContain("/unsubscribe/");
  });

  it("sends one 'failed' per failure and one 'issued' at the end", async () => {
    const refundId = approve(raise(buyForSelf().id));

    await payRefund(db, fail, refundId, NOW);
    await retryRefund(db, fail, refundId, later(1000));
    await retryRefund(db, succeed, refundId, later(2000));

    expect(refundNotifications().map((n) => n.type)).toEqual([
      schema.NotificationType.RefundFailed,
      schema.NotificationType.RefundFailed,
      schema.NotificationType.RefundIssued,
    ]);
  });

  it("names both amounts for a Partial Refund", async () => {
    const refundId = approve(raise(buyForSelf().id), 4000, "Half.");

    await payRefund(db, succeed, refundId, NOW);

    const [issued] = refundNotifications();
    expect(issued.text).toBe(
      "Your refund of $40.00 (of the $79.00 you paid) for Test Course has been sent"
    );
    expect(emailFor(issued.id)?.body).toContain("$40.00 (of the $79.00 you paid)");
  });

  it("goes only to the Team Admin who bought a Team Licence, linking to /team", async () => {
    const refundId = approve(raise(buySeats().id));

    await payRefund(db, succeed, refundId, NOW);

    const [issued] = refundNotifications();
    expect(issued).toMatchObject({ recipientUserId: base.user.id, href: "/team" });
    expect(refundNotifications()).toHaveLength(1);
  });

  it("writes nothing when the payment is refused as a duplicate", async () => {
    const refundId = approve(raise(buyForSelf().id));
    await payRefund(db, succeed, refundId, NOW);

    await payRefund(db, succeed, refundId, NOW);

    expect(refundNotifications()).toHaveLength(1);
  });
});
