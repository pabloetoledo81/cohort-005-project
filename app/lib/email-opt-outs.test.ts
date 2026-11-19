import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationType } from "~/db/schema";
import { notifyAboutNewComment } from "./comment-notifications.server";
import {
  getEmailPreferences,
  hasOptedOut,
  setEmailOptOut,
} from "./email-opt-outs.server";
import type { Email, MailTransport } from "./mailer.server";
import { processDueDeliveries } from "./outbox.server";
import { deleteExpiredNotifications } from "./retention.server";
import { verifyUnsubscribeToken } from "./unsubscribe.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;

beforeEach(() => {
  vi.stubEnv("UNSUBSCRIBE_SECRET", "test-only-secret");
  vi.stubEnv("APP_URL", "https://cadence.test");
  db = createTestDb();
  base = seedBaseData(db);
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Variables", position: 1 })
    .returning()
    .get().id;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const instructor = () => base.instructor.id;

/** A Student posts a Discussion Question, which the Instructor gets. */
function postQuestion() {
  return db.transaction((tx) => {
    const comment = tx
      .insert(schema.comments)
      .values({ userId: base.user.id, lessonId, parentId: null, body: "Why?" })
      .returning()
      .get();
    notifyAboutNewComment(tx, comment, NOW);
    return comment;
  });
}

const deliveries = () => db.select().from(schema.notificationDeliveries).all();
const notifications = () => db.select().from(schema.notifications).all();

describe("Email Opt-outs", () => {
  it("leaves optional emails on by default", () => {
    postQuestion();

    expect(deliveries()).toHaveLength(1);
    expect(
      getEmailPreferences(db, instructor()).find(
        (p) => p.type === NotificationType.NewDiscussionQuestion
      )
    ).toMatchObject({ emailOn: true, mandatory: false });
  });

  it("stops that Type's email but keeps the Feed item", () => {
    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, true, NOW);

    postQuestion();

    expect(notifications()).toHaveLength(1);
    expect(deliveries()).toHaveLength(0);
  });

  it("only covers the one Type", () => {
    setEmailOptOut(
      db,
      base.user.id,
      NotificationType.DiscussionQuestionAnswered,
      true,
      NOW
    );

    postQuestion();

    // The Instructor's New Discussion Question email is unaffected.
    expect(deliveries()).toHaveLength(1);
  });

  it("is harmless to opt out twice", () => {
    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, true, NOW);
    const again = setEmailOptOut(
      db,
      instructor(),
      NotificationType.NewDiscussionQuestion,
      true,
      NOW
    );

    expect(again).toEqual({ ok: true });
    expect(db.select().from(schema.emailOptOuts).all()).toHaveLength(1);
  });

  it("deletes the row on opting back in, and resends nothing", () => {
    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, true, NOW);
    postQuestion();

    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, false, NOW);

    expect(db.select().from(schema.emailOptOuts).all()).toHaveLength(0);
    expect(deliveries()).toHaveLength(0);
    postQuestion();
    expect(deliveries()).toHaveLength(1);
  });

  it("still sends an email already in the outbox", async () => {
    postQuestion();
    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, true, NOW);

    const sent: Email[] = [];
    const transport: MailTransport = {
      async send(email) {
        sent.push(email);
        return { messageId: null };
      },
    };
    await processDueDeliveries(db, transport, NOW);

    expect(sent).toHaveLength(1);
  });

  it.each([
    NotificationType.RefundRequestRaised,
    NotificationType.RefundRequestApproved,
    NotificationType.RefundRequestDeclined,
    NotificationType.RefundIssued,
    NotificationType.RefundFailed,
  ])("refuses to opt out of the Mandatory %s", (type) => {
    expect(setEmailOptOut(db, base.user.id, type, true, NOW)).toEqual({
      ok: false,
      error: "These emails are always sent.",
    });
    expect(hasOptedOut(db, base.user.id, type)).toBe(false);
  });

  it("refuses a Type with no email to opt out of", () => {
    expect(
      setEmailOptOut(db, base.user.id, NotificationType.ReplyToYourComment, true, NOW).ok
    ).toBe(false);
  });

  it("lists the Mandatory Types as always on in Settings", () => {
    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, true, NOW);

    const preferences = getEmailPreferences(db, instructor());

    expect(preferences.filter((p) => p.mandatory).every((p) => p.emailOn)).toBe(true);
    expect(preferences.map((p) => p.label)).toEqual([
      "New Discussion Question on your course",
      "Your Discussion Question was answered",
      "Refund Request raised",
      "Refund Request approved",
      "Refund Request declined",
      "Refund issued",
      "Refund failed",
    ]);
    expect(
      preferences.find((p) => p.type === NotificationType.NewDiscussionQuestion)?.emailOn
    ).toBe(false);
  });

  it("survives retention", async () => {
    setEmailOptOut(db, instructor(), NotificationType.NewDiscussionQuestion, true, NOW);

    await deleteExpiredNotifications(db, new Date("2030-01-01T00:00:00Z"));

    expect(hasOptedOut(db, instructor(), NotificationType.NewDiscussionQuestion)).toBe(
      true
    );
  });
});

describe("without UNSUBSCRIBE_SECRET in production", () => {
  it("still saves the Comment and its Notification, but skips the optional email", () => {
    vi.stubEnv("UNSUBSCRIBE_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => postQuestion()).not.toThrow();

    expect(db.select().from(schema.comments).all()).toHaveLength(1);
    expect(notifications()).toHaveLength(1);
    expect(deliveries()).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("UNSUBSCRIBE_SECRET"));
    error.mockRestore();
  });
});

describe("the unsubscribe link and headers", () => {
  it("ends every optional email with a link that opts out of that Type", () => {
    postQuestion();

    const [delivery] = deliveries();
    const match = delivery.body.match(
      /Turn off these emails: https:\/\/cadence\.test\/unsubscribe\/(\S+)$/
    );
    expect(match).not.toBeNull();
    expect(verifyUnsubscribeToken(match![1])).toEqual({
      userId: instructor(),
      type: NotificationType.NewDiscussionQuestion,
    });
  });

  it("sends optional emails with RFC 8058 one-click headers", async () => {
    postQuestion();
    const sent: Email[] = [];
    await processDueDeliveries(
      db,
      {
        async send(email) {
          sent.push(email);
          return { messageId: null };
        },
      },
      NOW
    );

    expect(sent[0].headers).toEqual({
      "List-Unsubscribe": expect.stringMatching(
        /^<https:\/\/cadence\.test\/unsubscribe\/.+>$/
      ),
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});
