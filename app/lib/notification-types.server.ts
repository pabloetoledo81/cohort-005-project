import { NotificationType } from "~/db/schema";
import type { MessageStream } from "~/lib/mailer.server";
import type { PurchaseKind } from "~/lib/refunds.server";
import { appUrl } from "~/lib/unsubscribe.server";
import { formatPrice } from "~/lib/utils";

// ─── Notification Types ───
// The registry of everything a Notification Type means: its Channels, whether
// it is Mandatory, its Postmark stream, and its Feed and email templates.
// Nothing about a Type is stored beyond its name on each row, so adding a
// Type is a new enum value plus an entry here.
//
// Templates are rendered once, when the Notification is created. Later
// wording changes never rewrite rows that already exist.

export type RenderedNotification = {
  recipientUserId: number;
  /** The Feed line. */
  text: string;
  /** Where clicking the Feed line goes. */
  href: string;
  /** Null for a Type that has no email Channel. */
  email: { subject: string; body: string } | null;
  commentId?: number;
  refundRequestId?: number;
};

type Definition<Payload> = {
  /** How Settings names the Type. */
  label: string;
  /** Whether the Type has an email Channel (every Type is on the Feed). */
  sendsEmail: boolean;
  /** A Mandatory Type can't be opted out of and carries no unsubscribe. */
  mandatory: boolean;
  stream: MessageStream;
  render(payload: Payload): RenderedNotification;
};

// ─── Refund Requests ───
// All go to the buyer only, on the Feed and by email, and are Mandatory.

export type RefundRequestPayload = {
  refundRequestId: number;
  buyer: { id: number; name: string };
  courseTitle: string;
  amountPaid: number;
  /** Set once approved: the full amount for a Team Licence, the amount the
   * Platform Admin chose for an Individual Purchase. */
  approvedAmount: number | null;
  kind: PurchaseKind;
  /** The Platform Admin's note. It goes in the email only, never the Feed. */
  note: string | null;
};

const SIGN_OFF = ["", "— The Cadence team"];

/** Where the buyer sees a Purchase's refund state and the decision note. */
function refundPageFor(kind: PurchaseKind) {
  return kind === "team_licence" ? "/team" : "/settings";
}

function refundNotification(
  payload: RefundRequestPayload,
  text: string,
  subject: string,
  middle: string[]
): RenderedNotification {
  return {
    recipientUserId: payload.buyer.id,
    text,
    href: refundPageFor(payload.kind),
    refundRequestId: payload.refundRequestId,
    email: {
      subject: `${subject} — ${payload.courseTitle}`,
      body: [`Hi ${payload.buyer.name},`, "", ...middle, ...SIGN_OFF].join(
        "\n"
      ),
    },
  };
}

/**
 * The approved amount, and for a Partial Refund the amount paid beside it:
 * "$40.00 (of the $79.00 you paid)".
 */
export function refundAmount(p: RefundRequestPayload): string {
  const approved = p.approvedAmount ?? p.amountPaid;
  return approved < p.amountPaid
    ? `${formatPrice(approved)} (of the ${formatPrice(p.amountPaid)} you paid)`
    : formatPrice(approved);
}

function noteLines(note: string | null) {
  return note ? ["", note] : [];
}

const refundRequestRaised: Definition<RefundRequestPayload> = {
  label: "Refund Request raised",
  sendsEmail: true,
  mandatory: true,
  stream: "transactional",
  render: (p) =>
    refundNotification(
      p,
      `We received your refund request for ${p.courseTitle}`,
      "Refund requested",
      [
        `We have your refund request for "${p.courseTitle}".`,
        // A Team Licence is refunded in full; an Individual Purchase's amount
        // is decided on review, so don't promise it yet.
        p.kind === "team_licence"
          ? `The refund is for ${formatPrice(p.amountPaid)}, the amount you paid.`
          : `You paid ${formatPrice(p.amountPaid)} for it.`,
        "",
        "Our team reviews every refund request by hand. You do not need to do anything else. We'll let you know once it's been decided.",
      ]
    ),
};

const refundRequestApproved: Definition<RefundRequestPayload> = {
  label: "Refund Request approved",
  sendsEmail: true,
  mandatory: true,
  stream: "transactional",
  render: (p) =>
    refundNotification(
      p,
      `Your refund request for ${p.courseTitle} was approved`,
      "Refund approved",
      [
        `We have approved your refund request for "${p.courseTitle}".`,
        `Your refund of ${refundAmount(p)} has been approved. We'll let you know as soon as the money has been sent.`,
        ...noteLines(p.note),
      ]
    ),
};

const refundRequestDeclined: Definition<RefundRequestPayload> = {
  label: "Refund Request declined",
  sendsEmail: true,
  mandatory: true,
  stream: "transactional",
  render: (p) =>
    refundNotification(
      p,
      `Your refund request for ${p.courseTitle} was declined`,
      "Refund declined",
      [
        `We have looked at your refund request for "${p.courseTitle}" and decided not to refund it.`,
        ...noteLines(p.note),
        "",
        "You still have everything you bought. If something changes, you can raise a new refund request.",
      ]
    ),
};

// ─── Comments ───
// Who is notified about a Comment is decided in
// app/lib/comment-notifications.server.ts; these only render.

export type CommentPayload = {
  recipientUserId: number;
  recipientName: string;
  /** Who wrote the Comment the Notification is about. */
  authorName: string;
  courseTitle: string;
  lessonTitle: string;
  /** The Comment's text, as written (Markdown). */
  commentBody: string;
  /** The lesson, scrolled to the Comment. */
  href: string;
  commentId: number;
};

const EXCERPT_LENGTH = 300;

function excerpt(body: string) {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH
    ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…`
    : flat;
}

function commentNotification(
  payload: CommentPayload,
  text: string,
  email: { subject: string; opening: string; action: string } | null
): RenderedNotification {
  return {
    recipientUserId: payload.recipientUserId,
    text,
    href: payload.href,
    commentId: payload.commentId,
    email: email && {
      subject: email.subject,
      body: [
        `Hi ${payload.recipientName},`,
        "",
        email.opening,
        "",
        excerpt(payload.commentBody),
        "",
        `${email.action}: ${appUrl()}${payload.href}`,
        ...SIGN_OFF,
      ].join("\n"),
    },
  };
}

const newDiscussionQuestion: Definition<CommentPayload> = {
  label: "New Discussion Question on your course",
  sendsEmail: true,
  mandatory: false,
  stream: "transactional",
  render: (p) =>
    commentNotification(
      p,
      `${p.authorName} posted a Discussion Question on “${p.lessonTitle}”`,
      {
        subject: `New Discussion Question — ${p.courseTitle}`,
        opening: `${p.authorName} posted a Discussion Question on "${p.lessonTitle}" in ${p.courseTitle}:`,
        action: "Read it and reply",
      }
    ),
};

const discussionQuestionAnswered: Definition<CommentPayload> = {
  label: "Your Discussion Question was answered",
  sendsEmail: true,
  mandatory: false,
  stream: "transactional",
  render: (p) =>
    commentNotification(
      p,
      `${p.authorName} answered your Discussion Question on “${p.lessonTitle}”`,
      {
        subject: `Your Discussion Question was answered — ${p.courseTitle}`,
        opening: `${p.authorName} answered your Discussion Question on "${p.lessonTitle}" in ${p.courseTitle}:`,
        action: "Read the answer",
      }
    ),
};

const replyToYourComment: Definition<CommentPayload> = {
  label: "Reply to your Comment",
  // Feed only: peer replies can be frequent, so email would be noise.
  sendsEmail: false,
  mandatory: false,
  stream: "transactional",
  render: (p) =>
    commentNotification(
      p,
      `${p.authorName} replied to your Comment on “${p.lessonTitle}”`,
      null
    ),
};

// ─── The registry ───

export interface NotificationPayloads {
  [NotificationType.NewDiscussionQuestion]: CommentPayload;
  [NotificationType.DiscussionQuestionAnswered]: CommentPayload;
  [NotificationType.ReplyToYourComment]: CommentPayload;
  [NotificationType.RefundRequestRaised]: RefundRequestPayload;
  [NotificationType.RefundRequestApproved]: RefundRequestPayload;
  [NotificationType.RefundRequestDeclined]: RefundRequestPayload;
}

export type RegisteredType = keyof NotificationPayloads;

export const notificationTypes: {
  [T in RegisteredType]: Definition<NotificationPayloads[T]>;
} = {
  [NotificationType.NewDiscussionQuestion]: newDiscussionQuestion,
  [NotificationType.DiscussionQuestionAnswered]: discussionQuestionAnswered,
  [NotificationType.ReplyToYourComment]: replyToYourComment,
  [NotificationType.RefundRequestRaised]: refundRequestRaised,
  [NotificationType.RefundRequestApproved]: refundRequestApproved,
  [NotificationType.RefundRequestDeclined]: refundRequestDeclined,
};

export function isRegistered(type: NotificationType): type is RegisteredType {
  return type in notificationTypes;
}

export function isMandatory(type: NotificationType): boolean {
  return isRegistered(type) && notificationTypes[type].mandatory;
}

/** Types whose email a person may turn off: optional and with an email. */
export function isOptionalEmail(type: NotificationType): boolean {
  return (
    isRegistered(type) &&
    notificationTypes[type].sendsEmail &&
    !notificationTypes[type].mandatory
  );
}

/** Every Type that sends email, as Settings lists them. */
export function emailTypes() {
  return (Object.keys(notificationTypes) as RegisteredType[])
    .filter((type) => notificationTypes[type].sendsEmail)
    .map((type) => ({
      type,
      label: notificationTypes[type].label,
      mandatory: notificationTypes[type].mandatory,
    }));
}

export function streamFor(type: NotificationType): MessageStream {
  return type in notificationTypes
    ? notificationTypes[type as RegisteredType].stream
    : "transactional";
}
