import { data, Link } from "react-router";
import type { Route } from "./+types/unsubscribe.$token";
import { db } from "~/db";
import { setEmailOptOut } from "~/lib/email-opt-outs.server";
import { emailTypes } from "~/lib/notification-types.server";
import { verifyUnsubscribeToken } from "~/lib/unsubscribe.server";

// One-click unsubscribe from one Notification Type's email. No login: the
// signed token says who and which Type. A GET comes from the "Turn off these
// emails" link in the email; a POST comes from a mail client's unsubscribe
// button (RFC 8058, body "List-Unsubscribe=One-Click"). Both opt out at once,
// and doing it twice is harmless.

function optOut(token: string) {
  const verified = verifyUnsubscribeToken(token);
  if (!verified) {
    throw data("This unsubscribe link isn't valid.", { status: 400 });
  }

  const result = setEmailOptOut(
    db,
    verified.userId,
    verified.type,
    true,
    new Date()
  );
  if (!result.ok) {
    throw data(result.error, { status: 400 });
  }

  const label =
    emailTypes().find((t) => t.type === verified.type)?.label ?? "these";
  return { label };
}

export function meta() {
  return [{ title: "Email turned off — Cadence" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  return optOut(params.token);
}

export async function action({ params }: Route.ActionArgs) {
  return optOut(params.token);
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
  const { label } = actionData ?? loaderData;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-2xl font-bold">Email turned off</h1>
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
