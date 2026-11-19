import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationType, UserRole } from "~/db/schema";
import { notifyAboutNewComment } from "./comment-notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let student: number;
let otherStudent: number;
let instructor: number;
let platformAdmin: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  student = base.user.id;
  instructor = base.instructor.id;
  otherStudent = addUser("Noor", UserRole.Student);
  platformAdmin = addUser("Pat", UserRole.Admin);

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

function addUser(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get().id;
}

/** Posts a Comment the way the lesson route does. */
function post(userId: number, parentId: number | null = null) {
  return db.transaction((tx) => {
    const comment = tx
      .insert(schema.comments)
      .values({ userId, lessonId, parentId, body: "Hello" })
      .returning()
      .get();
    notifyAboutNewComment(tx, comment, NOW);
    return comment;
  });
}

function notifications() {
  return db.select().from(schema.notifications).all();
}

function onlyNotification() {
  const all = notifications();
  expect(all).toHaveLength(1);
  return all[0];
}

describe("a new top-level Comment", () => {
  it("is a Discussion Question when a Student posts it, and notifies the Instructor", () => {
    const question = post(student);

    expect(onlyNotification()).toMatchObject({
      recipientUserId: instructor,
      type: NotificationType.NewDiscussionQuestion,
      text: "Test User posted a Discussion Question on “Variables”",
      href: `/courses/test-course/lessons/${lessonId}#comment-${question.id}`,
      commentId: question.id,
    });
  });

  it("notifies nobody when the Instructor posts it", () => {
    post(instructor);
    expect(notifications()).toHaveLength(0);
  });

  it("notifies nobody when a Platform Admin posts it", () => {
    post(platformAdmin);
    expect(notifications()).toHaveLength(0);
  });

  it("notifies whoever is the course's Instructor when it is posted", () => {
    const newInstructor = addUser("Ada", UserRole.Instructor);
    db.update(schema.courses)
      .set({ instructorId: newInstructor })
      .where(eq(schema.courses.id, base.course.id))
      .run();

    post(student);

    expect(onlyNotification().recipientUserId).toBe(newInstructor);
  });

  it("emails the Instructor too", () => {
    post(student);

    const [delivery] = db.select().from(schema.notificationDeliveries).all();
    expect(delivery).toMatchObject({
      toAddress: "instructor@example.com",
      subject: "New Discussion Question — Test Course",
      mandatory: false,
    });
    expect(delivery.body).toContain(
      'Test User posted a Discussion Question on "Variables" in Test Course:'
    );
    expect(delivery.body).toContain("Hello");
  });
});

describe("a reply", () => {
  function clear() {
    db.delete(schema.notificationDeliveries).run();
    db.delete(schema.notifications).run();
  }

  it("from the Instructor answers a Discussion Question", () => {
    const question = post(student);
    clear();

    const reply = post(instructor, question.id);

    expect(onlyNotification()).toMatchObject({
      recipientUserId: student,
      type: NotificationType.DiscussionQuestionAnswered,
      text: "Test Instructor answered your Discussion Question on “Variables”",
      commentId: reply.id,
      href: `/courses/test-course/lessons/${lessonId}#comment-${reply.id}`,
    });
  });

  it("from a Platform Admin answers a Discussion Question", () => {
    const question = post(student);
    clear();

    post(platformAdmin, question.id);

    expect(onlyNotification().type).toBe(NotificationType.DiscussionQuestionAnswered);
  });

  it("answers again on every staff reply, not just the first", () => {
    const question = post(student);
    clear();

    post(instructor, question.id);
    post(platformAdmin, question.id);

    expect(notifications().map((n) => n.type)).toEqual([
      NotificationType.DiscussionQuestionAnswered,
      NotificationType.DiscussionQuestionAnswered,
    ]);
  });

  it("from another Student is a Reply to your Comment, on the Feed only", () => {
    const question = post(student);
    clear();
    db.delete(schema.notificationDeliveries).run();

    post(otherStudent, question.id);

    expect(onlyNotification()).toMatchObject({
      recipientUserId: student,
      type: NotificationType.ReplyToYourComment,
      text: "Noor replied to your Comment on “Variables”",
    });
    expect(db.select().from(schema.notificationDeliveries).all()).toHaveLength(0);
  });

  it("that answers a Discussion Question is emailed to the asker", () => {
    const question = post(student);
    db.delete(schema.notificationDeliveries).run();

    post(instructor, question.id);

    const [delivery] = db.select().from(schema.notificationDeliveries).all();
    expect(delivery).toMatchObject({
      toAddress: "test@example.com",
      subject: "Your Discussion Question was answered — Test Course",
    });
  });

  it("to the Instructor's own top-level Comment is a Reply to your Comment", () => {
    const announcement = post(instructor);

    post(student, announcement.id);

    expect(onlyNotification()).toMatchObject({
      recipientUserId: instructor,
      type: NotificationType.ReplyToYourComment,
    });
  });

  it("from staff to a staff top-level Comment is a Reply to your Comment", () => {
    const announcement = post(instructor);

    post(platformAdmin, announcement.id);

    expect(onlyNotification().type).toBe(NotificationType.ReplyToYourComment);
  });

  it("notifies nobody when you reply to your own Comment", () => {
    const question = post(student);
    clear();

    post(student, question.id);

    expect(notifications()).toHaveLength(0);
  });

  it("notifies nobody else in the thread", () => {
    const question = post(student);
    post(otherStudent, question.id);
    clear();

    post(instructor, question.id);

    expect(onlyNotification().recipientUserId).toBe(student);
  });

  it("notifies nobody under a deleted top-level Comment", () => {
    const question = post(student);
    clear();
    db.update(schema.comments)
      .set({ deletedAt: NOW.toISOString() })
      .where(eq(schema.comments.id, question.id))
      .run();

    post(instructor, question.id);

    expect(notifications()).toHaveLength(0);
  });

  it("still notifies a Lapsed author", () => {
    // The author has no Enrollment at all; being Lapsed doesn't stop it.
    db.delete(schema.enrollments).run();
    const question = post(student);
    clear();

    post(instructor, question.id);

    expect(onlyNotification().recipientUserId).toBe(student);
  });
});
