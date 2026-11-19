import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NotificationType } from "~/db/schema";

// ─── One-click unsubscribe ───
// The link in an optional email carries a token: the person and the
// Notification Type, signed with HMAC-SHA256. It is stored nowhere and never
// expires; opting out twice is harmless. Rotating the secret breaks the links
// in old emails, which is acceptable because Settings still works.
//
// The secret comes from UNSUBSCRIBE_SECRET, set from a secrets manager or the
// host's secret store. Never commit it. Without it, production can't sign
// links, so optional emails are skipped (the Feed still gets everything; see
// canSignUnsubscribeLinks). Development makes up a random one per process
// (links then stop working after a restart).

let devSecret: string | undefined;

/**
 * Whether unsubscribe links can be signed. An optional email must never go
 * out without one, so when this is false the email is skipped, not sent bare.
 */
export function canSignUnsubscribeLinks(): boolean {
  return (
    Boolean(process.env.UNSUBSCRIBE_SECRET) ||
    process.env.NODE_ENV !== "production"
  );
}

function secret(): string {
  const configured = process.env.UNSUBSCRIBE_SECRET;
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "UNSUBSCRIBE_SECRET is not set. Set it from your secrets manager."
    );
  }

  if (!devSecret) {
    devSecret = randomBytes(32).toString("hex");
    console.warn(
      "UNSUBSCRIBE_SECRET is not set; using a random one for this process. Unsubscribe links will break on restart."
    );
  }
  return devSecret;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function unsubscribeToken(userId: number, type: NotificationType) {
  const payload = Buffer.from(`${userId}:${type}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The person and Type a token was made for, or null if it was tampered with. */
export function verifyUnsubscribeToken(
  token: string
): { userId: number; type: NotificationType } | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  const [userPart, type] = Buffer.from(payload, "base64url")
    .toString()
    .split(":");
  const userId = Number(userPart);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Object.values(NotificationType).includes(type as NotificationType)) {
    return null;
  }

  return { userId, type: type as NotificationType };
}

/** The app's public URL, for links inside emails. */
export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
}

export function unsubscribeUrl(userId: number, type: NotificationType) {
  return `${appUrl()}/unsubscribe/${unsubscribeToken(userId, type)}`;
}

/** RFC 8058 one-click headers for an optional email. */
export function unsubscribeHeaders(
  userId: number,
  type: NotificationType
): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl(userId, type)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
