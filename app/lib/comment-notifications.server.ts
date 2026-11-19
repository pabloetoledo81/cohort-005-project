import { eq } from "drizzle-orm";
import {
  comments,
  courses,
  lessons,
  modules,
  NotificationType,
  UserRole,
  users,
} from "~/db/schema";
import { notify, type Queryable } from "~/lib/notifications.server";

// ─── Who is notified about a new Comment ───
// See GLOSSARY.md (Discussions) for the terms.
//
// - A Discussion Question (a top-level Comment by anyone but the course's
//   Instructor or a Platform Admin) notifies the course's Instructor.
// - A reply notifies only the author of the top-level Comment it sits under:
//   "Discussion Question answered" when the course's Instructor or a Platform
//   Admin replies to a Discussion Question, "Reply to your Comment" otherwise.
//   One Notification per reply, never both.
// - Nobody is notified about their own Comment, or about a reply under a
//   deleted top-level Comment. Edits and deletions never notify. Lapsed people
//   are notified like anyone else.
//
// Call it in the same transaction that inserts the Comment.

type Comment = typeof comments.$inferSelect;

export function notifyAboutNewComment(
  db: Queryable,
  comment: Comment,
  now: Date
): void {
  const context = db
    .select({
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, comment.lessonId))
    .get();
  if (!context) return;

  const author = getUser(db, comment.userId);
  if (!author) return;

  const isStaff = (user: { id: number; role: UserRole }) =>
    user.id === context.instructorId || user.role === UserRole.Admin;

  const payload = (recipient: { id: number; name: string }) => ({
    recipientUserId: recipient.id,
    recipientName: recipient.name,
    authorName: author.name,
    courseTitle: context.courseTitle,
    lessonTitle: context.lessonTitle,
    commentBody: comment.body,
    href: `/courses/${context.courseSlug}/lessons/${comment.lessonId}#comment-${comment.id}`,
    commentId: comment.id,
  });

  if (comment.parentId === null) {
    // A top-level Comment by staff is just a Comment.
    if (isStaff(author)) return;
    const instructor = getUser(db, context.instructorId);
    if (!instructor) return;
    notify(db, NotificationType.NewDiscussionQuestion, payload(instructor), now);
    return;
  }

  const parent = db
    .select()
    .from(comments)
    .where(eq(comments.id, comment.parentId))
    .get();
  if (!parent || parent.deletedAt !== null) return;
  if (parent.userId === author.id) return;

  const parentAuthor = getUser(db, parent.userId);
  if (!parentAuthor) return;

  const isDiscussionQuestion = !isStaff(parentAuthor);
  const type =
    isDiscussionQuestion && isStaff(author)
      ? NotificationType.DiscussionQuestionAnswered
      : NotificationType.ReplyToYourComment;

  notify(db, type, payload(parentAuthor), now);
}

function getUser(db: Queryable, userId: number) {
  return db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
}
