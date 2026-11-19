import { db } from "~/db";
import { defaultTransport } from "~/lib/mailer.server";
import { startOutboxPoller } from "~/lib/outbox.server";
import { startRetentionTimer } from "~/lib/retention.server";

// ─── Background jobs ───
// Cadence runs as one long-lived server process (docs/adr/0013), so its
// background work runs on in-process timers. app/entry.server.tsx calls this
// when the server loads. The global flag keeps it to once per process, even
// when the dev server reloads the module.

const STARTED = Symbol.for("cadence.backgroundJobsStarted");

export function startBackgroundJobs() {
  const registry = globalThis as typeof globalThis & { [STARTED]?: boolean };
  if (registry[STARTED]) return;
  registry[STARTED] = true;

  startOutboxPoller(db, defaultTransport);
  // A separate timer, so a slow cleanup never delays email.
  startRetentionTimer(db);
}
