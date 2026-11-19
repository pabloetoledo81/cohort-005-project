import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Transactional email ───
// Postmark delivers every email when POSTMARK_SERVER_TOKEN is set. Without a
// token (local dev, tests) each message is written to .outbox/ as a JSON file
// instead, so it can be read without sending anything.
//
// Routes never send email directly: they create a Notification, and the outbox
// poller (app/lib/outbox.server.ts) sends its Delivery. See docs/adr/0013.

// The Postmark Message Stream an email goes out on. Every v1 Notification
// Type is transactional.
export type MessageStream = "transactional";

const POSTMARK_STREAM_IDS: Record<MessageStream, string> = {
  // Postmark's default transactional stream is called "outbound".
  transactional: "outbound",
};

export type Email = {
  to: string;
  subject: string;
  body: string;
  stream?: MessageStream;
  headers?: Record<string, string>;
};

export type SendResult = { messageId: string | null };

/**
 * A send the provider refused. Permanent means retrying can never succeed
 * (the recipient is inactive, suppressed or invalid). Anything else, and any
 * network error, is treated as temporary and retried.
 */
export class MailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

// Postmark API ErrorCodes that mean this recipient can never receive the
// email, from https://postmarkapp.com/developer/api/overview:
// 406 "Inactive recipient": hard bounce, spam complaint or manual suppression.
// 300 "Invalid email request": send validation, including an invalid address.
const PERMANENT_POSTMARK_ERROR_CODES = new Set([300, 406]);

const SEND_TIMEOUT_MS = 15_000;

export interface MailTransport {
  send(email: Email): Promise<SendResult>;
}

const FROM_ADDRESS = "Cadence <hello@cadence.dev>";

export function postmarkTransport(serverToken: string): MailTransport {
  return {
    async send(email) {
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": serverToken,
        },
        body: JSON.stringify({
          From: FROM_ADDRESS,
          To: email.to,
          Subject: email.subject,
          TextBody: email.body,
          MessageStream: POSTMARK_STREAM_IDS[email.stream ?? "transactional"],
          Headers: Object.entries(email.headers ?? {}).map(([Name, Value]) => ({
            Name,
            Value,
          })),
        }),
        // A hung request must not stall the outbox; a timeout is temporary.
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw await postmarkError(response);
      }

      const sent = (await response.json()) as { MessageID?: string };
      return { messageId: sent.MessageID ?? null };
    },
  };
}

/**
 * Turns a Postmark error response into a MailSendError. Postmark's error body
 * is { ErrorCode, Message }. Only the ErrorCodes above are permanent: 429 and
 * 5xx are temporary by nature, and an unknown failure is retried too, because
 * retries are bounded and a later attempt may succeed.
 */
async function postmarkError(response: Response): Promise<MailSendError> {
  let errorCode: number | null = null;
  let detail = "";
  try {
    const body = (await response.json()) as {
      ErrorCode?: number;
      Message?: string;
    };
    errorCode = typeof body.ErrorCode === "number" ? body.ErrorCode : null;
    detail = body.Message ?? "";
  } catch {
    // Not JSON: keep just the HTTP status.
  }

  const permanent =
    response.status === 422 &&
    errorCode !== null &&
    PERMANENT_POSTMARK_ERROR_CODES.has(errorCode);

  return new MailSendError(
    `Postmark returned HTTP ${response.status}` +
      (errorCode !== null ? `, ErrorCode ${errorCode}` : "") +
      (detail ? `: ${detail}` : ""),
    permanent
  );
}

export function outboxTransport(directory: string): MailTransport {
  return {
    async send(email) {
      mkdirSync(directory, { recursive: true });
      // The random part keeps two emails to one person in the same
      // millisecond from overwriting each other.
      const file = join(
        directory,
        `${Date.now()}-${randomUUID().slice(0, 8)}-${email.to}.json`
      );
      writeFileSync(
        file,
        JSON.stringify({ from: FROM_ADDRESS, ...email }, null, 2)
      );
      return { messageId: null };
    },
  };
}

export function defaultTransport(): MailTransport {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  return token ? postmarkTransport(token) : outboxTransport(".outbox");
}

export async function sendEmail(
  email: Email,
  transport: MailTransport = defaultTransport()
): Promise<SendResult> {
  return transport.send(email);
}
