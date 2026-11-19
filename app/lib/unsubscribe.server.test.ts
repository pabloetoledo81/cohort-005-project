import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationType } from "~/db/schema";
import {
  unsubscribeHeaders,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe.server";

beforeEach(() => {
  vi.stubEnv("UNSUBSCRIBE_SECRET", "test-only-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("unsubscribe tokens", () => {
  it("round-trips the person and Type", () => {
    const token = unsubscribeToken(42, NotificationType.NewDiscussionQuestion);

    expect(verifyUnsubscribeToken(token)).toEqual({
      userId: 42,
      type: NotificationType.NewDiscussionQuestion,
    });
  });

  it("is the same every time, so it never needs storing", () => {
    expect(unsubscribeToken(1, NotificationType.NewDiscussionQuestion)).toBe(
      unsubscribeToken(1, NotificationType.NewDiscussionQuestion)
    );
  });

  it("rejects a tampered signature", () => {
    const token = unsubscribeToken(42, NotificationType.NewDiscussionQuestion);
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");

    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a token re-pointed at another person or Type", () => {
    const token = unsubscribeToken(42, NotificationType.NewDiscussionQuestion);
    const [, signature] = token.split(".");

    const otherUser = Buffer.from(`43:${NotificationType.NewDiscussionQuestion}`).toString(
      "base64url"
    );
    const otherType = Buffer.from(
      `42:${NotificationType.DiscussionQuestionAnswered}`
    ).toString("base64url");

    expect(verifyUnsubscribeToken(`${otherUser}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${otherType}.${signature}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = unsubscribeToken(42, NotificationType.NewDiscussionQuestion);
    vi.stubEnv("UNSUBSCRIBE_SECRET", "a-rotated-secret");

    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it.each(["", "garbage", "a.b.c", "....."])("rejects %j", (token) => {
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("refuses to sign in production without a configured secret", () => {
    vi.stubEnv("UNSUBSCRIBE_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");

    expect(() =>
      unsubscribeToken(1, NotificationType.NewDiscussionQuestion)
    ).toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("builds RFC 8058 headers", () => {
    vi.stubEnv("APP_URL", "https://cadence.test/");

    expect(unsubscribeHeaders(7, NotificationType.DiscussionQuestionAnswered)).toEqual({
      "List-Unsubscribe": `<https://cadence.test/unsubscribe/${unsubscribeToken(
        7,
        NotificationType.DiscussionQuestionAnswered
      )}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});
