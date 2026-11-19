import { and, eq } from "drizzle-orm";
import { emailOptOuts, type NotificationType } from "~/db/schema";
import { emailTypes, isOptionalEmail } from "~/lib/notification-types.server";
import type { Queryable } from "~/lib/notifications.server";

// ─── Email Opt-outs ───
// A person's choice to stop email for one Notification Type. It covers email
// only: the Notification still appears in their Feed. Email is on by default;
// no row means on. Only optional Types with an email can be opted out of —
// never a Mandatory one, whichever route asks.

export function hasOptedOut(
  db: Queryable,
  userId: number,
  type: NotificationType
): boolean {
  return !!db
    .select({ id: emailOptOuts.id })
    .from(emailOptOuts)
    .where(and(eq(emailOptOuts.userId, userId), eq(emailOptOuts.type, type)))
    .get();
}

export type OptOutResult = { ok: true } | { ok: false; error: string };

/**
 * Turns one Type's email off (optedOut = true) or back on. Both directions
 * are idempotent. Opting back in resends nothing.
 */
export function setEmailOptOut(
  db: Queryable,
  userId: number,
  type: NotificationType,
  optedOut: boolean,
  now: Date
): OptOutResult {
  if (!isOptionalEmail(type)) {
    return { ok: false, error: "These emails are always sent." };
  }

  if (optedOut) {
    db.insert(emailOptOuts)
      .values({ userId, type, createdAt: now.toISOString() })
      .onConflictDoNothing()
      .run();
  } else {
    db.delete(emailOptOuts)
      .where(and(eq(emailOptOuts.userId, userId), eq(emailOptOuts.type, type)))
      .run();
  }

  return { ok: true };
}

/** What Settings shows: every Type that sends email, and whether it's on. */
export function getEmailPreferences(db: Queryable, userId: number) {
  const optedOut = new Set(
    db
      .select({ type: emailOptOuts.type })
      .from(emailOptOuts)
      .where(eq(emailOptOuts.userId, userId))
      .all()
      .map((row) => row.type)
  );

  return emailTypes().map((t) => ({
    ...t,
    emailOn: t.mandatory || !optedOut.has(t.type),
  }));
}
