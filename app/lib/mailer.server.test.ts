import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MailSendError,
  outboxTransport,
  postmarkTransport,
  sendEmail,
} from "./mailer.server";

describe("sendEmail", () => {
  it("writes the message to the outbox when there is no Postmark token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await sendEmail(
      { to: "liam@example.com", subject: "Hello", body: "Hi Liam" },
      outboxTransport(directory)
    );

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toMatchObject({
      to: "liam@example.com",
      subject: "Hello",
      body: "Hi Liam",
    });
  });
});

describe("postmarkTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respondWith(status: number, body: unknown) {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const email = { to: "liam@example.com", subject: "Hello", body: "Hi Liam" };

  async function failureOf(status: number, body: unknown) {
    respondWith(status, body);
    const error = await postmarkTransport("test-token")
      .send(email)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailSendError);
    return error as MailSendError;
  }

  it("returns Postmark's message id and sends on the transactional stream", async () => {
    const fetchMock = respondWith(200, { ErrorCode: 0, MessageID: "abc-123" });

    const result = await postmarkTransport("test-token").send({
      ...email,
      headers: { "List-Unsubscribe": "<https://example.com/u>" },
    });

    expect(result).toEqual({ messageId: "abc-123" });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string
    );
    expect(sent).toMatchObject({
      MessageStream: "outbound",
      Headers: [{ Name: "List-Unsubscribe", Value: "<https://example.com/u>" }],
    });
  });

  it("treats an inactive recipient as permanent", async () => {
    const error = await failureOf(422, {
      ErrorCode: 406,
      Message: "You tried to send to a recipient that has been marked as inactive.",
    });
    expect(error.permanent).toBe(true);
    expect(error.message).toContain("ErrorCode 406");
  });

  it("treats an invalid email request as permanent", async () => {
    expect((await failureOf(422, { ErrorCode: 300, Message: "Invalid 'To'" })).permanent).toBe(true);
  });

  it.each([
    [429, {}],
    [500, {}],
    [503, { ErrorCode: 100, Message: "Maintenance" }],
    [422, { ErrorCode: 403, Message: "Invalid request field(s)" }],
  ])("treats HTTP %i as temporary", async (status, body) => {
    expect((await failureOf(status, body)).permanent).toBe(false);
  });
});
