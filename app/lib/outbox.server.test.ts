import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { DeliveryStatus, NotificationType } from "~/db/schema";
import {
  MailSendError,
  outboxTransport,
  type Email,
  type MailTransport,
} from "./mailer.server";
import { notify } from "./notifications.server";
import {
  MAX_ATTEMPTS,
  processDueDeliveries,
  RETRY_DELAYS_MINUTES,
} from "./outbox.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function recordingTransport() {
  const sent: Email[] = [];
  const transport: MailTransport = {
    async send(email) {
      sent.push(email);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return { sent, transport };
}

function queueRefundEmail(at = NOW) {
  return notify(
    db,
    NotificationType.RefundRequestRaised,
    {
      refundRequestId: 0,
      buyer: { id: base.user.id, name: base.user.name },
      courseTitle: "Test Course",
      amountPaid: 7900,
      approvedAmount: null,
      kind: "individual_purchase",
      note: null,
    },
    at
  );
}

function minutesLater(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function minutesAfterNow(minutes: number) {
  return minutesLater(minutes).toISOString();
}

function delivery(id: number) {
  return db
    .select()
    .from(schema.notificationDeliveries)
    .all()
    .find((d) => d.id === id)!;
}

describe("the email outbox", () => {
  beforeEach(() => {
    // The refund request referenced by these Notifications doesn't matter here.
    db.$client.pragma("foreign_keys = OFF");
  });

  it("sends a due Delivery and marks it sent", async () => {
    const { deliveryId } = queueRefundEmail();
    const { sent, transport } = recordingTransport();

    const processed = await processDueDeliveries(db, transport, NOW);

    expect(processed).toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({
        to: "test@example.com",
        subject: "Refund requested — Test Course",
        stream: "transactional",
      }),
    ]);
    // A Mandatory Type carries no unsubscribe headers.
    expect(sent[0].headers).toBeUndefined();
    expect(delivery(deliveryId!)).toMatchObject({
      status: DeliveryStatus.Sent,
      attempts: 1,
      providerMessageId: "msg-1",
    });
    expect(delivery(deliveryId!).sentAt).not.toBeNull();
  });

  it("sends each Delivery once", async () => {
    queueRefundEmail();
    const { sent, transport } = recordingTransport();

    await processDueDeliveries(db, transport, NOW);
    await processDueDeliveries(db, transport, NOW);

    expect(sent).toHaveLength(1);
  });

  it("leaves a Delivery that isn't due yet", async () => {
    queueRefundEmail(new Date(NOW.getTime() + 60_000));
    const { sent, transport } = recordingTransport();

    expect(await processDueDeliveries(db, transport, NOW)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("writes to .outbox/ in development", async () => {
    queueRefundEmail();
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await processDueDeliveries(db, outboxTransport(directory), NOW);

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory, files[0]), "utf8"))).toMatchObject({
      to: "test@example.com",
      subject: "Refund requested — Test Course",
    });
  });

  it("retries a temporary failure with a growing delay", async () => {
    const { deliveryId } = queueRefundEmail();
    const failing: MailTransport = {
      async send() {
        throw new MailSendError("Postmark returned HTTP 503", false);
      },
    };

    await processDueDeliveries(db, failing, NOW);
    expect(delivery(deliveryId!)).toMatchObject({
      status: DeliveryStatus.Pending,
      attempts: 1,
      lastError: "Postmark returned HTTP 503",
      nextAttemptAt: minutesAfterNow(1),
    });

    // Not due yet: nothing is attempted.
    await processDueDeliveries(db, failing, new Date(NOW.getTime() + 30_000));
    expect(delivery(deliveryId!).attempts).toBe(1);

    await processDueDeliveries(db, failing, minutesLater(1));
    expect(delivery(deliveryId!)).toMatchObject({
      attempts: 2,
      nextAttemptAt: minutesAfterNow(1 + 4),
    });
  });

  it("retries a network error as temporary", async () => {
    const { deliveryId } = queueRefundEmail();
    const failing: MailTransport = {
      async send() {
        throw new TypeError("fetch failed");
      },
    };

    await processDueDeliveries(db, failing, NOW);

    expect(delivery(deliveryId!).status).toBe(DeliveryStatus.Pending);
  });

  it("gives up after the last attempt and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deliveryId } = queueRefundEmail();
    const failing: MailTransport = {
      async send() {
        throw new MailSendError("Postmark returned HTTP 500", false);
      },
    };

    let at = NOW;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await processDueDeliveries(db, failing, at);
      at = new Date(delivery(deliveryId!).nextAttemptAt);
    }

    expect(delivery(deliveryId!)).toMatchObject({
      status: DeliveryStatus.Failed,
      attempts: MAX_ATTEMPTS,
      lastError: "Postmark returned HTTP 500",
    });
    expect(error).toHaveBeenCalledOnce();
    expect(MAX_ATTEMPTS).toBe(5);
    // Five attempts span roughly an hour.
    expect(RETRY_DELAYS_MINUTES.reduce((a, b) => a + b)).toBeLessThanOrEqual(60);

    // A failed Delivery is never picked up again.
    await processDueDeliveries(db, failing, minutesLater(600));
    expect(delivery(deliveryId!).attempts).toBe(MAX_ATTEMPTS);
  });

  it("doesn't retry a permanent failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deliveryId } = queueRefundEmail();
    const failing: MailTransport = {
      async send() {
        throw new MailSendError("Inactive recipient", true);
      },
    };

    await processDueDeliveries(db, failing, NOW);

    expect(delivery(deliveryId!)).toMatchObject({
      status: DeliveryStatus.Failed,
      attempts: 1,
    });
  });

  it("keeps sending other Deliveries when one fails", async () => {
    const first = queueRefundEmail();
    const second = queueRefundEmail();
    let calls = 0;
    const flaky: MailTransport = {
      async send() {
        calls++;
        if (calls === 1) throw new MailSendError("Postmark returned HTTP 503", false);
        return { messageId: "ok" };
      },
    };

    await processDueDeliveries(db, flaky, NOW);

    expect(delivery(first.deliveryId!).status).toBe(DeliveryStatus.Pending);
    expect(delivery(second.deliveryId!).status).toBe(DeliveryStatus.Sent);
  });

  it("leaves the Notification alone when the email fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { notificationId, deliveryId } = queueRefundEmail();
    const failing: MailTransport = {
      async send() {
        throw new Error("boom");
      },
    };

    await processDueDeliveries(db, failing, NOW);

    expect(delivery(deliveryId!).status).not.toBe(DeliveryStatus.Sent);
    expect(delivery(deliveryId!).lastError).toContain("boom");
    expect(
      db.select().from(schema.notifications).all().map((n) => n.id)
    ).toEqual([notificationId]);
  });
});
