import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationType } from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { unsubscribeToken } from "~/lib/unsubscribe.server";

// The routes behind Notifications, called as React Router would call them,
// against an in-memory database. Covers what the library tests can't: no
// login for unsubscribing, and the server refusing other people's data.

type TestDb = ReturnType<typeof createTestDb>;

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", () => ({
  get db() {
    return holder.db;
  },
}));

const unsubscribe = await import("./unsubscribe.$token");
const feed = await import("./api.notifications");
const settings = await import("./settings");
const lesson = await import("./courses.$slug.lessons.$lessonId");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  vi.stubEnv("UNSUBSCRIBE_SECRET", "test-only-secret");
  db = createTestDb();
  holder.db = db;
  base = seedBaseData(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The Cookie header that signs this person in. */
async function cookieFor(userId: number) {
  const setCookie = await setCurrentUserId(new Request("http://test/"), userId);
  return setCookie.split(";")[0];
}

function post(url: string, body: Record<string, string>, cookie?: string) {
  return new Request(url, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    body: new URLSearchParams(body),
  });
}

/** Route functions take React Router's full args; these tests need only a few. */
function args<T>(partial: { request: Request; params?: Record<string, string> }) {
  return { params: {}, context: {}, ...partial } as unknown as T;
}

const optOuts = () => db.select().from(schema.emailOptOuts).all();

describe("the unsubscribe page", () => {
  const url = (token: string) => `http://test/unsubscribe/${token}`;
  const token = () =>
    unsubscribeToken(base.instructor.id, NotificationType.NewDiscussionQuestion);

  it("only asks when the link is opened, so mail scanners change nothing", async () => {
    const result = await unsubscribe.loader(
      args({ request: new Request(url(token())), params: { token: token() } })
    );

    expect(result).toEqual({ label: "New Discussion Question on your course" });
    expect(optOuts()).toHaveLength(0);
  });

  it("opts out on the RFC 8058 one-click POST, with no login", async () => {
    const request = post(url(token()), { "List-Unsubscribe": "One-Click" });

    await unsubscribe.action(args({ request, params: { token: token() } }));

    expect(optOuts()).toEqual([
      expect.objectContaining({
        userId: base.instructor.id,
        type: NotificationType.NewDiscussionQuestion,
      }),
    ]);
  });

  it("is harmless twice", async () => {
    for (let i = 0; i < 2; i++) {
      await unsubscribe.action(
        args({ request: post(url(token()), {}), params: { token: token() } })
      );
    }
    expect(optOuts()).toHaveLength(1);
  });

  it("rejects a tampered link", async () => {
    const bad = `${token()}x`;
    await expect(
      unsubscribe.action(args({ request: post(url(bad), {}), params: { token: bad } }))
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(optOuts()).toHaveLength(0);
  });

  it("rejects a link for a Mandatory Type", async () => {
    const mandatory = unsubscribeToken(
      base.user.id,
      NotificationType.RefundRequestApproved
    );
    await expect(
      unsubscribe.loader(
        args({ request: new Request(url(mandatory)), params: { token: mandatory } })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
  });
});

describe("the Feed API", () => {
  function addNotification(recipientUserId: number) {
    return db
      .insert(schema.notifications)
      .values({
        recipientUserId,
        type: NotificationType.RefundRequestRaised,
        text: "Hello",
        href: "/settings",
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }

  it("needs someone signed in", async () => {
    await expect(
      feed.loader(args({ request: new Request("http://test/api/notifications") }))
    ).rejects.toMatchObject({ init: { status: 401 } });
  });

  it("lists only the signed-in person's Notifications", async () => {
    addNotification(base.user.id);
    addNotification(base.instructor.id);

    const result = await feed.loader(
      args({
        request: new Request("http://test/api/notifications", {
          headers: { Cookie: await cookieFor(base.user.id) },
        }),
      })
    );

    expect(result.total).toBe(1);
  });

  it.each(["0", "-1", "abc", "5000"])("refuses limit=%s", async (limit) => {
    await expect(
      feed.loader(
        args({
          request: new Request(`http://test/api/notifications?limit=${limit}`, {
            headers: { Cookie: await cookieFor(base.user.id) },
          }),
        })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
  });

  it("won't mark someone else's Notification read", async () => {
    const theirs = addNotification(base.instructor.id);

    await expect(
      feed.action(
        args({
          request: post(
            "http://test/api/notifications",
            { intent: "read", notificationId: String(theirs.id) },
            await cookieFor(base.user.id)
          ),
        })
      )
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(
      db.select().from(schema.notifications).where(eq(schema.notifications.id, theirs.id)).get()
        ?.readAt
    ).toBeNull();
  });
});

describe("Settings email preferences", () => {
  it("refuses to turn off a Mandatory Type", async () => {
    await expect(
      settings.action(
        args({
          request: post(
            "http://test/settings",
            {
              intent: "email-preference",
              type: NotificationType.RefundRequestApproved,
              emailOn: "false",
            },
            await cookieFor(base.user.id)
          ),
        })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(optOuts()).toHaveLength(0);
  });

  it("turns an optional Type off and on", async () => {
    const cookie = await cookieFor(base.instructor.id);
    const set = (emailOn: string) =>
      settings.action(
        args({
          request: post(
            "http://test/settings",
            {
              intent: "email-preference",
              type: NotificationType.NewDiscussionQuestion,
              emailOn,
            },
            cookie
          ),
        })
      );

    await set("false");
    expect(optOuts()).toHaveLength(1);
    await set("true");
    expect(optOuts()).toHaveLength(0);
  });
});

describe("editing and deleting a Comment", () => {
  it("never notifies anyone", async () => {
    const module = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    const lessonId = db
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: "One", position: 1 })
      .returning()
      .get().id;
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    const cookie = await cookieFor(base.user.id);
    const params = { slug: base.course.slug, lessonId: String(lessonId) };
    const url = `http://test/courses/${base.course.slug}/lessons/${lessonId}`;
    const act = (body: Record<string, string>) =>
      lesson.action(args({ request: post(url, body, cookie), params }));

    await act({ intent: "create-comment", body: "Why does this work?" });
    const question = db.select().from(schema.comments).get();
    if (!question) throw new Error("The Comment wasn't created.");
    // Creating the Discussion Question notified the Instructor once.
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);

    await act({ intent: "edit-comment", commentId: String(question.id), body: "Edited." });
    await act({ intent: "delete-comment", commentId: String(question.id) });

    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
  });
});
