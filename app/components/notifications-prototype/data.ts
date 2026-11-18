// PROTOTYPE — throwaway. Mock Notifications for the In-app Channel prototype.
// Nothing here is persisted; state lives in memory and resets on reload.

export type NotificationType =
  | "new-discussion-question"
  | "discussion-question-answered"
  | "reply-to-your-comment"
  | "refund-request-raised"
  | "refund-request-approved"
  | "refund-request-declined"
  | "refund-issued"
  | "refund-failed";

export type MockNotification = {
  id: number;
  type: NotificationType;
  /** Who/what caused it, e.g. "Priya Shah" */
  actor: string;
  /** What it's about, e.g. lesson or course title */
  subject: string;
  course: string;
  /** Grouping key: the thing several Notifications can be about */
  groupKey: string;
  /** Where clicking takes you */
  href: string;
  excerpt?: string;
  createdAt: string;
  readAt: string | null;
};

export const TYPE_LABEL: Record<NotificationType, string> = {
  "new-discussion-question": "New Discussion Question",
  "discussion-question-answered": "Discussion Question answered",
  "reply-to-your-comment": "Reply to your Comment",
  "refund-request-raised": "Refund Request raised",
  "refund-request-approved": "Refund Request approved",
  "refund-request-declined": "Refund Request declined",
  "refund-issued": "Refund issued",
  "refund-failed": "Refund failed",
};

export function headline(n: MockNotification): string {
  switch (n.type) {
    case "new-discussion-question":
      return `${n.actor} asked a question on “${n.subject}”`;
    case "discussion-question-answered":
      return `${n.actor} answered your question on “${n.subject}”`;
    case "reply-to-your-comment":
      return `${n.actor} replied to your Comment on “${n.subject}”`;
    case "refund-request-raised":
      return `We have your Refund Request for “${n.course}”`;
    case "refund-request-approved":
      return `Your Refund Request for “${n.course}” was approved`;
    case "refund-request-declined":
      return `Your Refund Request for “${n.course}” was declined`;
    case "refund-issued":
      return `Your refund for “${n.course}” has been sent`;
    case "refund-failed":
      return `We couldn't send your refund for “${n.course}” — we're on it`;
  }
}

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const lesson = (slug: string, lessonId: number, commentId?: number) =>
  `/courses/${slug}/lessons/${lessonId}${commentId ? `#comment-${commentId}` : ""}`;

function studentSet(): MockNotification[] {
  let id = 1;
  const n = (p: Omit<MockNotification, "id">): MockNotification => ({ id: id++, ...p });
  return [
    // Five peer replies on one lesson: the grouping question.
    ...["Priya Shah", "Tom Reyes", "Ana Lima", "Ben Okafor", "Kim Cho"].map((actor, i) =>
      n({
        type: "reply-to-your-comment",
        actor,
        subject: "Closures in loops",
        course: "JavaScript Foundations",
        groupKey: "comment-101",
        href: lesson("javascript-foundations", 12, 101),
        excerpt: [
          "Same thing tripped me up — use let instead of var.",
          "The MDN page on closures explains this well.",
          "+1, the second example finally made it click.",
          "Try logging i inside the callback, you'll see it.",
          "Thanks for asking this, I had the same question!",
        ][i],
        createdAt: ago(5 + i * 9),
        readAt: null,
      })
    ),
    n({
      type: "discussion-question-answered",
      actor: "Dr. Elena Ruiz (Instructor)",
      subject: "Closures in loops",
      course: "JavaScript Foundations",
      groupKey: "comment-101",
      href: lesson("javascript-foundations", 12, 101),
      excerpt: "Great question. var is function-scoped, so every callback sees the same i…",
      createdAt: ago(3),
      readAt: null,
    }),
    n({
      type: "refund-request-approved",
      actor: "Cadence",
      subject: "Refund Request",
      course: "Advanced TypeScript Patterns",
      groupKey: "refund-77",
      href: "/courses/advanced-typescript-patterns",
      createdAt: ago(60 * 5),
      readAt: null,
    }),
    n({
      type: "refund-request-raised",
      actor: "Cadence",
      subject: "Refund Request",
      course: "Advanced TypeScript Patterns",
      groupKey: "refund-77",
      href: "/courses/advanced-typescript-patterns",
      createdAt: ago(60 * 30),
      readAt: ago(60 * 29),
    }),
    n({
      type: "discussion-question-answered",
      actor: "Marcus Lee (Instructor)",
      subject: "Flexbox vs Grid",
      course: "CSS Layouts",
      groupKey: "comment-55",
      href: lesson("css-layouts", 4, 55),
      excerpt: "Reach for Grid when you're laying out two dimensions…",
      createdAt: ago(60 * 26),
      readAt: ago(60 * 20),
    }),
    n({
      type: "refund-failed",
      actor: "Cadence",
      subject: "Refund",
      course: "Intro to SQL",
      groupKey: "refund-61",
      href: "/courses/intro-to-sql",
      createdAt: ago(60 * 24 * 3),
      readAt: ago(60 * 24 * 2),
    }),
    n({
      type: "refund-issued",
      actor: "Cadence",
      subject: "Refund",
      course: "Docker Basics",
      groupKey: "refund-40",
      href: "/courses/docker-basics",
      createdAt: ago(60 * 24 * 9),
      readAt: ago(60 * 24 * 8),
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function instructorSet(): MockNotification[] {
  let id = 100;
  const n = (p: Omit<MockNotification, "id">): MockNotification => ({ id: id++, ...p });
  const asks = [
    ["Sam Patel", "Closures in loops", 12, "Why does my loop print 5 five times?"],
    ["Lena Kraus", "Closures in loops", 12, "Is this the same issue as with setTimeout?"],
    ["Omar Haddad", "Promises and async", 14, "When should I use Promise.all vs allSettled?"],
    ["Yuki Tanaka", "The event loop", 15, "Are microtasks always before macrotasks?"],
    ["Chris Doyle", "Closures in loops", 12, "Great lesson, thanks!"],
    ["Ines Duarte", "Modules", 18, "Do I need a bundler for ES modules?"],
  ] as const;
  return [
    ...asks.map(([actor, subject, lessonId, excerpt], i) =>
      n({
        type: "new-discussion-question",
        actor,
        subject,
        course: "JavaScript Foundations",
        groupKey: `lesson-${lessonId}`,
        href: lesson("javascript-foundations", lessonId, 200 + i),
        excerpt,
        createdAt: ago(4 + i * 47),
        readAt: i > 3 ? ago(10) : null,
      })
    ),
    n({
      type: "reply-to-your-comment",
      actor: "Priya Shah",
      subject: "Course kickoff",
      course: "JavaScript Foundations",
      groupKey: "comment-9",
      href: lesson("javascript-foundations", 1, 9),
      excerpt: "Excited to start — is there a recommended pace?",
      createdAt: ago(60 * 30),
      readAt: null,
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function overflowSet(base: MockNotification[]): MockNotification[] {
  const out = [...base];
  for (let i = 0; i < 80; i++) {
    const src = base[i % base.length];
    out.push({
      ...src,
      id: 1000 + i,
      groupKey: `${src.groupKey}-old-${Math.floor(i / 3)}`,
      createdAt: new Date(
        new Date(src.createdAt).getTime() - (i + 1) * 6 * 3_600_000
      ).toISOString(),
      readAt: i < 25 ? null : src.createdAt,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type FeedState = "normal" | "empty" | "overflow";

export function mockNotifications(
  role: string | null,
  state: FeedState
): MockNotification[] {
  if (state === "empty") return [];
  const base = role === "instructor" ? instructorSet() : studentSet();
  return state === "overflow" ? overflowSet(base) : base;
}
