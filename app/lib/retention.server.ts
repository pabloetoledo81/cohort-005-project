import { and, eq, inArray, lt, ne, notExists } from "drizzle-orm";
import type { Db } from "~/db/types";
import {
  DeliveryStatus,
  notificationDeliveries,
  notifications,
} from "~/db/schema";

// ─── Retention ───
// Notifications (read or unread) are hard-deleted after 180 days, and their
// Deliveries go with them. A pending Delivery is never deleted, so neither is
// its Notification. Email Opt-outs are standing preferences and are never
// cleaned up.
//
// Deletes in small batches, Deliveries first, so SQLite's write lock is held
// briefly. A run that stops partway finishes on the next run.

export const RETENTION_DAYS = 180;
export const BATCH_SIZE = 500;
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Notifications created before this are past retention. */
export function retentionCutoff(now: Date) {
  return new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
}

/** Deletes one batch. Returns how many rows it deleted. */
export function deleteExpiredBatch(db: Db, now: Date): number {
  const expired = lt(notifications.createdAt, retentionCutoff(now));

  const deliveries = db
    .delete(notificationDeliveries)
    .where(
      inArray(
        notificationDeliveries.id,
        db
          .select({ id: notificationDeliveries.id })
          .from(notificationDeliveries)
          .innerJoin(
            notifications,
            eq(notificationDeliveries.notificationId, notifications.id)
          )
          .where(
            and(expired, ne(notificationDeliveries.status, DeliveryStatus.Pending))
          )
          .limit(BATCH_SIZE)
      )
    )
    .run().changes;

  if (deliveries > 0) return deliveries;

  // Only once no expired Delivery is left to delete. A Notification still
  // waiting on a pending Delivery stays until that Delivery ends.
  return db
    .delete(notifications)
    .where(
      inArray(
        notifications.id,
        db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              expired,
              notExists(
                db
                  .select({ id: notificationDeliveries.id })
                  .from(notificationDeliveries)
                  .where(eq(notificationDeliveries.notificationId, notifications.id))
              )
            )
          )
          .limit(BATCH_SIZE)
      )
    )
    .run().changes;
}

/**
 * Deletes everything expired, a batch at a time, yielding to the event loop
 * between batches so requests keep being served.
 */
export async function deleteExpiredNotifications(
  db: Db,
  now: Date
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = deleteExpiredBatch(db, now);
    if (deleted === 0) return total;
    total += deleted;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Runs the cleanup once at startup and then every 24 hours, on its own timer
 * so a slow cleanup never delays the email outbox.
 */
export function startRetentionTimer(db: Db): () => void {
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      const deleted = await deleteExpiredNotifications(db, new Date());
      if (deleted > 0) {
        console.log(`Retention: deleted ${deleted} expired Notification rows.`);
      }
    } catch (error) {
      console.error("Retention cleanup failed:", error);
    } finally {
      running = false;
    }
  }

  const startup = setTimeout(run, 0);
  startup.unref();
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();

  return () => {
    clearTimeout(startup);
    clearInterval(timer);
  };
}
