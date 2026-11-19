import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export enum UserRole {
  Student = "student",
  Instructor = "instructor",
  Admin = "admin",
}

export enum CourseStatus {
  Draft = "draft",
  Published = "published",
  Archived = "archived",
}

export enum LessonProgressStatus {
  NotStarted = "not_started",
  InProgress = "in_progress",
  Completed = "completed",
}

export enum QuestionType {
  MultipleChoice = "multiple_choice",
  TrueFalse = "true_false",
}

export enum RefundStatus {
  Open = "open",
  Approved = "approved",
  Declined = "declined",
}

export enum TeamMemberRole {
  Admin = "admin",
  Member = "member",
}

// The kind of thing that happened. What each Type means (who receives it,
// its Channels, whether it is Mandatory) lives in the registry in
// app/lib/notification-types.server.ts, not in the database.
export enum NotificationType {
  NewDiscussionQuestion = "new_discussion_question",
  DiscussionQuestionAnswered = "discussion_question_answered",
  ReplyToYourComment = "reply_to_your_comment",
  RefundRequestRaised = "refund_request_raised",
  RefundRequestApproved = "refund_request_approved",
  RefundRequestDeclined = "refund_request_declined",
  RefundIssued = "refund_issued",
  RefundFailed = "refund_failed",
}

// The Notification Feed is not a Channel with Deliveries: the Notification
// row is what the Feed shows. Only external Channels go through the outbox.
export enum DeliveryChannel {
  Email = "email",
}

export enum DeliveryStatus {
  Pending = "pending",
  Sent = "sent",
  Failed = "failed",
}

// ─── Tables ───

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().$type<UserRole>(),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
});

export const courses = sqliteTable("courses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull(),
  notes: text("notes"),
  // Markdown, non-empty. Enforced on write.
  salesCopy: text("sales_copy").notNull(),
  instructorId: integer("instructor_id")
    .notNull()
    .references(() => users.id),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
  status: text("status").notNull().$type<CourseStatus>(),
  coverImageUrl: text("cover_image_url"),
  price: integer("price").notNull().default(0),
  pppEnabled: integer("ppp_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const modules = sqliteTable("modules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  courseId: integer("course_id")
    .notNull()
    .references(() => courses.id),
  title: text("title").notNull(),
  position: integer("position").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const lessons = sqliteTable("lessons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  moduleId: integer("module_id")
    .notNull()
    .references(() => modules.id),
  title: text("title").notNull(),
  content: text("content"),
  videoUrl: text("video_url"),
  githubRepoUrl: text("github_repo_url"),
  position: integer("position").notNull(),
  durationMinutes: integer("duration_minutes"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const enrollments = sqliteTable(
  "enrollments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    enrolledAt: text("enrolled_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  },
  (table) => [index("enrollments_course_idx").on(table.courseId)]
);

export const lessonProgress = sqliteTable(
  "lesson_progress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessons.id),
    status: text("status").notNull().$type<LessonProgressStatus>(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("lesson_progress_user_lesson_idx").on(table.userId, table.lessonId),
  ]
);

export const quizzes = sqliteTable("quizzes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessons.id),
  title: text("title").notNull(),
  passingScore: real("passing_score").notNull(),
});

export const quizQuestions = sqliteTable("quiz_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzes.id),
  questionText: text("question_text").notNull(),
  questionType: text("question_type").notNull().$type<QuestionType>(),
  position: integer("position").notNull(),
});

export const quizOptions = sqliteTable("quiz_options", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  questionId: integer("question_id")
    .notNull()
    .references(() => quizQuestions.id),
  optionText: text("option_text").notNull(),
  isCorrect: integer("is_correct", { mode: "boolean" }).notNull(),
});

export const quizAttempts = sqliteTable("quiz_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzes.id),
  score: real("score").notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  attemptedAt: text("attempted_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const quizAnswers = sqliteTable("quiz_answers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  attemptId: integer("attempt_id")
    .notNull()
    .references(() => quizAttempts.id),
  questionId: integer("question_id")
    .notNull()
    .references(() => quizQuestions.id),
  selectedOptionId: integer("selected_option_id")
    .notNull()
    .references(() => quizOptions.id),
});

export const purchases = sqliteTable(
  "purchases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    amountPaid: integer("amount_paid").notNull(),
    country: text("country"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("purchases_course_idx").on(table.courseId)]
);

export const refunds = sqliteTable(
  "refunds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    purchaseId: integer("purchase_id")
      .notNull()
      .references(() => purchases.id),
    status: text("status")
      .notNull()
      .$type<RefundStatus>()
      .default(RefundStatus.Open),
    // The student's own words, in the box on the course page.
    reason: text("reason").notNull(),
    // Null until someone approves — a declined request refunds nothing.
    amountRefunded: integer("amount_refunded"),
    requestedAt: text("requested_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    resolvedAt: text("resolved_at"),
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    // The Platform Admin's note to the buyer. Required on a decline, optional
    // on an approval. Enforced on write.
    decisionNote: text("decision_note"),
  },
  (table) => [index("refunds_purchase_idx").on(table.purchaseId)]
);

export const teams = sqliteTable("teams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const teamMembers = sqliteTable("team_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  role: text("role").notNull().$type<TeamMemberRole>(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const coupons = sqliteTable("coupons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id),
  courseId: integer("course_id")
    .notNull()
    .references(() => courses.id),
  code: text("code").notNull().unique(),
  purchaseId: integer("purchase_id")
    .notNull()
    .references(() => purchases.id),
  redeemedByUserId: integer("redeemed_by_user_id").references(() => users.id),
  redeemedAt: text("redeemed_at"),
  // Set on every Unclaimed Seat when its Team Licence's Refund Request is
  // approved. The Seat can never be claimed after that.
  refundedAt: text("refunded_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const courseRatings = sqliteTable(
  "course_ratings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    // Whole stars, 1–5. Enforced on write.
    rating: integer("rating").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("course_ratings_user_course_unique").on(
      table.userId,
      table.courseId
    ),
  ]
);

export const comments = sqliteTable(
  "comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessons.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    // Null for a top-level comment. Replies are one level deep only — a parent
    // must itself be top-level. Enforced on write.
    parentId: integer("parent_id").references(
      (): AnySQLiteColumn => comments.id
    ),
    // Markdown, 1–5000 chars. Enforced on write, rendered by
    // renderComment (untrusted input — never renderMarkdown).
    body: text("body").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // Null until the author edits. An explicit column rather than comparing
    // updatedAt to createdAt, which collide when both writes land in the same
    // millisecond.
    editedAt: text("edited_at"),
    // Soft delete. Deleted top-level comments keep their replies readable.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("comments_lesson_idx").on(table.lessonId),
    index("comments_parent_idx").on(table.parentId),
  ]
);

export const videoWatchEvents = sqliteTable("video_watch_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessons.id),
  eventType: text("event_type").notNull(),
  positionSeconds: real("position_seconds").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Notifications ───
// See docs/adr/0013 for why email goes through an outbox table.

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipientUserId: integer("recipient_user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull().$type<NotificationType>(),
    // The Feed line and its link, rendered when the Notification is created.
    // Later template changes don't rewrite old rows.
    text: text("text").notNull(),
    href: text("href").notNull(),
    // Traceability only — nothing is rendered from these.
    commentId: integer("comment_id").references(() => comments.id),
    refundRequestId: integer("refund_request_id").references(() => refunds.id),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // Null until the recipient clicks it or marks all as read.
    readAt: text("read_at"),
  },
  (table) => [
    index("notifications_recipient_created_idx").on(
      table.recipientUserId,
      table.createdAt
    ),
  ]
);

// The outbox and the Delivery record in one. A Delivery may take several
// attempts and ends either sent or failed.
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    notificationId: integer("notification_id")
      .notNull()
      .references(() => notifications.id),
    channel: text("channel").notNull().$type<DeliveryChannel>(),
    // Rendered when the Notification is created; nothing is re-checked at
    // send time.
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    // True means no unsubscribe link and no List-Unsubscribe headers.
    mandatory: integer("mandatory", { mode: "boolean" }).notNull(),
    status: text("status")
      .notNull()
      .$type<DeliveryStatus>()
      .default(DeliveryStatus.Pending),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    sentAt: text("sent_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("notification_deliveries_notification_channel_unique").on(
      table.notificationId,
      table.channel
    ),
    index("notification_deliveries_due_idx").on(
      table.status,
      table.nextAttemptAt
    ),
  ]
);

// A person's choice to stop email for one Notification Type. No row means
// email is on, which is the default for everyone. Opting back in deletes the
// row. A Mandatory Type can never have one; that is enforced on write.
export const emailOptOuts = sqliteTable(
  "email_opt_outs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull().$type<NotificationType>(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("email_opt_outs_user_type_unique").on(table.userId, table.type),
  ]
);
