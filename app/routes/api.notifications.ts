import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { db } from "~/db";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import {
  FEED_PAGE_SIZE,
  getFeed,
  markAllNotificationsRead,
  markNotificationRead,
} from "~/lib/notifications.server";

// The Notification Feed behind the sidebar bell. GET returns the newest
// Notifications ("load older" asks for a bigger page); POST marks one or all
// of them read. Only ever the signed-in person's own Notifications.

async function requireUserId(request: Request) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  return userId;
}

// "Load older" grows the page 20 at a time; the cap keeps one request small.
const MAX_LIMIT = 1_000;

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(FEED_PAGE_SIZE),
});

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const query = feedQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!query.success) {
    throw data("Invalid request.", { status: 400 });
  }

  return getFeed(db, userId, query.data.limit, new Date());
}

const actionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("read"), notificationId: z.coerce.number().int() }),
  z.object({ intent: z.literal("read-all") }),
]);

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const parsed = parseFormData(await request.formData(), actionSchema);

  if (!parsed.success) {
    throw data("Invalid request.", { status: 400 });
  }

  if (parsed.data.intent === "read-all") {
    markAllNotificationsRead(db, userId, new Date());
    return { ok: true };
  }

  const href = markNotificationRead(
    db,
    userId,
    parsed.data.notificationId,
    new Date()
  );
  if (href === null) {
    throw data("Notification not found.", { status: 404 });
  }
  return { ok: true, href };
}
