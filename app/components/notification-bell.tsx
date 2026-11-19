import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import type { FeedItem } from "~/lib/notifications.server";

// The Notification Feed: a bell in the sidebar header that opens a dropdown.
// The dropdown is the whole Feed; there is no Feed page. A Notification is
// unread until it is clicked; opening the dropdown changes nothing.

const PAGE_SIZE = 20;
const FEED_URL = "/api/notifications";

type Feed = { items: FeedItem[]; total: number; unread: number };

export function unreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}

export function NotificationBell({ unreadCount }: { unreadCount: number }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const feed = useFetcher<Feed>();
  const mark = useFetcher();
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);

  // Load (or reload) the list whenever the dropdown opens or grows.
  useEffect(() => {
    if (open) feed.load(`${FEED_URL}?limit=${limit}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, limit]);

  // Close on a click outside or on Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const badge = unreadBadge(unreadCount);
  const items = feed.data?.items ?? [];
  const total = feed.data?.total ?? 0;

  function follow(item: FeedItem) {
    if (!item.read) {
      mark.submit(
        { intent: "read", notificationId: item.id },
        { method: "post", action: FEED_URL }
      );
    }
    setOpen(false);
    navigate(item.href);
  }

  function markAllRead() {
    mark.submit({ intent: "read-all" }, { method: "post", action: FEED_URL });
  }

  return (
    <div ref={container} className="relative ml-auto">
      <button
        type="button"
        onClick={() => {
          if (!open) setLimit(PAGE_SIZE);
          setOpen((o) => !o);
        }}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        aria-label={badge ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
      >
        <Bell className="size-5" />
        {badge && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-10 z-50 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-primary hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>

          {!feed.data ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              <Bell className="mx-auto mb-2 size-6 opacity-40" />
              You're all caught up.
            </div>
          ) : (
            <ul className="max-h-[28rem] divide-y overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => follow(item)}
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 text-left hover:bg-muted/60",
                      !item.read && "bg-primary/5"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        item.read ? "bg-transparent" : "bg-primary"
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn("block text-sm", !item.read && "font-medium")}
                      >
                        {item.text}
                      </span>
                      <span
                        className="mt-1 block text-xs text-muted-foreground"
                        suppressHydrationWarning
                      >
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {items.length < total && (
                <li className="px-4 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => setLimit((l) => l + PAGE_SIZE)}
                    className="text-xs text-primary hover:underline"
                  >
                    Showing {items.length} of {total}, load older
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
