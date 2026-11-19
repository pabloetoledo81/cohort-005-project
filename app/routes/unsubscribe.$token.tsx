import { data, Form, Link } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/unsubscribe.$token";
import { db } from "~/db";
import { setEmailOptOut } from "~/lib/email-opt-outs.server";
import { emailTypes, isOptionalEmail } from "~/lib/notification-types.server";
import { verifyUnsubscribeToken } from "~/lib/unsubscribe.server";
import { parseParams } from "~/lib/validation";

// Unsubscribe from one Notification Type's email, with no login: the signed
// token says who and which Type.
//
// Opening the link (GET) changes nothing: it shows what would be turned off
// and a button. Mail scanners open links in emails by themselves, so a GET
// that opted people out would do it without them knowing (RFC 8058). The
// opt-out happens on POST, which comes from that button or from a mail
// client's one-click unsubscribe (body "List-Unsubscribe=One-Click"). Doing it
// twice is harmless.

const paramsSchema = z.object({ token: z.string().min(1) });

function verify(params: Route.LoaderArgs["params"]) {
  const { token } = parseParams(params, paramsSchema);
  const verified = verifyUnsubscribeToken(token);
  if (!verified || !isOptionalEmail(verified.type)) {
    throw data("This unsubscribe link isn't valid.", { status: 400 });
  }
  const label =
    emailTypes().find((t) => t.type === verified.type)?.label ?? "these";
  return { ...verified, label };
}

export function meta() {
  return [{ title: "Turn off emails — Cadence" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { label } = verify(params);
  return { label };
}

export async function action({ params }: Route.ActionArgs) {
  const verified = verify(params);
  const result = setEmailOptOut(
    db,
    verified.userId,
    verified.type,
    true,
    new Date()
  );
  if (!result.ok) throw data(result.error, { status: 400 });
  return { turnedOff: true };
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
  const { label } = loaderData;

  if (actionData?.turnedOff) {
    return (
      <Centered title="Email turned off">
        <p className="text-muted-foreground">
          You won't get “{label}” emails any more. You'll still see them in
          your notifications in Cadence.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Changed your mind? Turn them back on in{" "}
          <Link to="/settings" className="text-primary hover:underline">
            Settings
          </Link>
          .
        </p>
      </Centered>
    );
  }

  return (
    <Centered title="Turn off these emails?">
      <p className="text-muted-foreground">
        You'll stop getting “{label}” emails. You'll still see them in your
        notifications in Cadence.
      </p>
      <Form method="post" className="mt-6">
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Turn off these emails
        </button>
      </Form>
    </Centered>
  );
}

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message =
    error && typeof error === "object" && "data" in error && typeof error.data === "string"
      ? error.data
      : "Something went wrong.";
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-2xl font-bold">We couldn't turn that off</h1>
        <p className="text-muted-foreground">{message}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          You can change your emails in{" "}
          <Link to="/settings" className="text-primary hover:underline">
            Settings
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
