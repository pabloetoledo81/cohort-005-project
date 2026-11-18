// PROTOTYPE — throwaway. Three structurally different In-app Channel
// (Notification Feed) variants, mounted in the real app shell via ?variant=.
//
//   A  Bell dropdown   — bell in sidebar header, popover, flat list, per-item read
//   B  Feed page       — sidebar nav item, full page, grouped by thread, seen ≠ read
//   C  Drawer by course — sidebar footer button, slide-over, grouped by course,
//                         opening = read, dismissable
//
// Read-only: clicking a Notification shows where it would go instead of navigating.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  Bell,
  BellDot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Inbox,
  MessageSquare,
  Receipt,
  X,
} from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import {
  headline,
  mockNotifications,
  TYPE_LABEL,
  type FeedState,
  type MockNotification,
} from "./data";

// ── shared in-memory feed state ─────────────────────────────────────────────

function useFeed(role: string | null, state: FeedState) {
  const [items, setItems] = useState<MockNotification[]>(() =>
    mockNotifications(role, state)
  );
  useEffect(() => setItems(mockNotifications(role, state)), [role, state]);

  const now = () => new Date().toISOString();
  return {
    items,
    unread: items.filter((n) => !n.readAt).length,
    markRead: (ids: number[]) =>
      setItems((xs) =>
        xs.map((n) => (ids.includes(n.id) && !n.readAt ? { ...n, readAt: now() } : n))
      ),
    markAllRead: () =>
      setItems((xs) => xs.map((n) => (n.readAt ? n : { ...n, readAt: now() }))),
    dismiss: (ids: number[]) => setItems((xs) => xs.filter((n) => !ids.includes(n.id))),
  };
}

type Feed = ReturnType<typeof useFeed>;

function follow(n: MockNotification) {
  toast.info(`Would navigate to ${n.href}`, {
    description: `${TYPE_LABEL[n.type]} — marked read`,
  });
}

function TypeIcon({ n, className }: { n: MockNotification; className?: string }) {
  return n.type.startsWith("refund") ? (
    <Receipt className={cn("size-4", className)} />
  ) : (
    <MessageSquare className={cn("size-4", className)} />
  );
}

function Badge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto min-w-5 rounded-full bg-red-600 px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// ── Variant A: bell + dropdown ──────────────────────────────────────────────

const A_PAGE = 20;

function useVariantA({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(A_PAGE);
  const visible = feed.items.slice(0, shown);

  const header = (
    <div className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        {feed.unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">
            {feed.unread > 9 ? "9+" : feed.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-50 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {feed.unread > 0 && (
              <button
                onClick={feed.markAllRead}
                className="text-xs text-primary hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
          {feed.items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              <Bell className="mx-auto mb-2 size-6 opacity-40" />
              You're all caught up.
            </div>
          ) : (
            <ul className="max-h-[28rem] divide-y overflow-y-auto">
              {visible.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      feed.markRead([n.id]);
                      setOpen(false);
                      follow(n);
                    }}
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 text-left hover:bg-muted/60",
                      !n.readAt && "bg-primary/5"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        n.readAt ? "bg-transparent" : "bg-primary"
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-sm", !n.readAt && "font-medium")}>
                        {headline(n)}
                      </span>
                      {n.excerpt && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {n.excerpt}
                        </span>
                      )}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {formatRelativeTime(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {shown < feed.items.length && (
                <li className="px-4 py-2 text-center">
                  <button
                    onClick={() => setShown((s) => s + A_PAGE)}
                    className="text-xs text-primary hover:underline"
                  >
                    Showing {shown} of {feed.items.length} — load older
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  return { header };
}

// ── Variant B: full Feed page, grouped by thread, seen ≠ read ───────────────

type Group = { key: string; items: MockNotification[] };

function groupByThread(items: MockNotification[]): Group[] {
  const groups = new Map<string, MockNotification[]>();
  for (const n of items) {
    const k = `${n.groupKey}:${n.type}`;
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function groupHeadline(g: Group): string {
  const [first, ...rest] = g.items;
  if (rest.length === 0) return headline(first);
  const others = `${first.actor} and ${rest.length} other${rest.length > 1 ? "s" : ""}`;
  if (first.type === "reply-to-your-comment")
    return `${others} replied to your Comment on “${first.subject}”`;
  if (first.type === "new-discussion-question")
    return `${others} asked questions on “${first.subject}”`;
  return `${headline(first)} (+${rest.length})`;
}

function bucket(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 24) return "Today";
  if (h < 24 * 7) return "This week";
  return "Earlier";
}

const B_PAGE = 15;

function useVariantB({ feed }: { feed: Feed }) {
  const [params, setParams] = useSearchParams();
  const pageOpen = params.get("feed") === "1";
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState(1);

  const unseen = feed.items.filter((n) => !n.readAt && !seenIds.has(n.id)).length;

  // Opening the page marks everything *seen* (badge clears) — not read.
  useEffect(() => {
    if (pageOpen) setSeenIds(new Set(feed.items.map((n) => n.id)));
  }, [pageOpen, feed.items]);

  const setOpen = (open: boolean) =>
    setParams(
      (p) => {
        open ? p.set("feed", "1") : p.delete("feed");
        return p;
      },
      { replace: true }
    );

  const nav = (
    <button
      onClick={() => setOpen(!pageOpen)}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        pageOpen
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <Inbox className="size-4" />
      Notifications
      <Badge count={unseen} />
    </button>
  );

  const filtered = tab === "unread" ? feed.items.filter((n) => !n.readAt) : feed.items;
  const groups = groupByThread(filtered);
  const visible = groups.slice(0, pages * B_PAGE);

  const main = pageOpen ? (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <button
          onClick={feed.markAllRead}
          disabled={feed.unread === 0}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
        >
          <CheckCheck className="size-4" /> Mark all as read
        </button>
      </div>
      <div className="mb-4 flex gap-1 border-b">
        {(["all", "unread"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm capitalize",
              tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground"
            )}
          >
            {t} {t === "unread" && feed.unread > 0 && `(${feed.unread})`}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          <Inbox className="mx-auto mb-3 size-8 opacity-40" />
          <p className="font-medium">
            {tab === "unread" ? "No unread Notifications" : "No Notifications yet"}
          </p>
          <p className="mt-1 text-sm">
            Replies to your Comments and updates on your refunds will show up here.
          </p>
        </div>
      ) : (
        <>
          {visible.map((g, i) => {
            const label = bucket(g.items[0].createdAt);
            const showLabel = i === 0 || bucket(visible[i - 1].items[0].createdAt) !== label;
            const unread = g.items.some((n) => !n.readAt);
            const isOpen = expanded.has(g.key);
            const multi = g.items.length > 1;
            return (
              <div key={g.key}>
                {showLabel && (
                  <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </h2>
                )}
                <div className={cn("mb-2 rounded-lg border", unread && "border-primary/40 bg-primary/5")}>
                  <div className="flex items-start gap-3 p-4">
                    <TypeIcon n={g.items[0]} className="mt-0.5 text-muted-foreground" />
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        feed.markRead(g.items.map((n) => n.id));
                        follow(g.items[g.items.length - 1]);
                      }}
                    >
                      <span className={cn("block text-sm", unread && "font-semibold")}>
                        {groupHeadline(g)}
                      </span>
                      {!multi && g.items[0].excerpt && (
                        <span className="mt-1 block text-sm text-muted-foreground">
                          “{g.items[0].excerpt}”
                        </span>
                      )}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {g.items[0].course} · {formatRelativeTime(g.items[0].createdAt)}
                      </span>
                    </button>
                    {multi && (
                      <button
                        onClick={() =>
                          setExpanded((s) => {
                            const next = new Set(s);
                            next.has(g.key) ? next.delete(g.key) : next.add(g.key);
                            return next;
                          })
                        }
                        className="rounded p-1 text-muted-foreground hover:bg-muted"
                        title="Show each"
                      >
                        {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                    )}
                  </div>
                  {multi && isOpen && (
                    <ul className="border-t">
                      {g.items.map((n) => (
                        <li key={n.id}>
                          <button
                            onClick={() => {
                              feed.markRead([n.id]);
                              follow(n);
                            }}
                            className="flex w-full gap-3 px-11 py-2 text-left text-sm hover:bg-muted/60"
                          >
                            <span className={cn("flex-1", !n.readAt && "font-medium")}>
                              {n.actor}: “{n.excerpt}”
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatRelativeTime(n.createdAt)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
          {visible.length < groups.length && (
            <button
              onClick={() => setPages((p) => p + 1)}
              className="mt-4 w-full rounded-md border py-2 text-sm hover:bg-muted"
            >
              Load older ({groups.length - visible.length} more)
            </button>
          )}
        </>
      )}
    </div>
  ) : null;

  return { nav, main };
}

// ── Variant C: slide-over drawer grouped by course, open = read ─────────────

const RETENTION_DAYS = 30;

function useVariantC({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());

  const recent = useMemo(
    () =>
      feed.items.filter(
        (n) => Date.now() - new Date(n.createdAt).getTime() < RETENTION_DAYS * 86_400_000
      ),
    [feed.items]
  );
  const hiddenOld = feed.items.length - recent.length;

  const openDrawer = () => {
    // Opening the drawer reads everything; remember what was new for highlighting.
    setFreshIds(new Set(feed.items.filter((n) => !n.readAt).map((n) => n.id)));
    feed.markAllRead();
    setOpen(true);
  };

  const sections = useMemo(() => {
    const m = new Map<string, MockNotification[]>();
    for (const n of recent) {
      const k = n.type.startsWith("refund") ? "Purchases & refunds" : n.course;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return [...m.entries()];
  }, [recent]);

  const footer = (
    <button
      onClick={openDrawer}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      {feed.unread > 0 ? <BellDot className="size-4 text-red-600" /> : <Bell className="size-4" />}
      Notifications
      {feed.unread > 0 && (
        <span className="ml-auto text-xs text-red-600">{feed.unread} new</span>
      )}
    </button>
  );

  const overlay = open ? (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
      <aside
        className="flex h-full w-[26rem] flex-col bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <button onClick={() => setOpen(false)} className="rounded p-1 hover:bg-muted">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sections.length === 0 ? (
            <div className="px-6 py-20 text-center text-muted-foreground">
              <Bell className="mx-auto mb-3 size-8 opacity-40" />
              <p className="font-medium">Nothing new</p>
              <p className="mt-1 text-sm">We'll let you know when someone replies to you.</p>
            </div>
          ) : (
            sections.map(([title, items]) => {
              const isCollapsed = collapsed.has(title);
              const fresh = items.filter((n) => freshIds.has(n.id)).length;
              return (
                <section key={title} className="border-b">
                  <button
                    onClick={() =>
                      setCollapsed((s) => {
                        const next = new Set(s);
                        next.has(title) ? next.delete(title) : next.add(title);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-2 bg-muted/40 px-5 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    <span className="flex-1 truncate">{title}</span>
                    <span>
                      {items.length}
                      {fresh > 0 && <span className="ml-1 text-primary">· {fresh} new</span>}
                    </span>
                  </button>
                  {!isCollapsed &&
                    items.map((n) => (
                      <div
                        key={n.id}
                        className={cn(
                          "group flex gap-3 px-5 py-3",
                          freshIds.has(n.id) && "border-l-2 border-primary bg-primary/5"
                        )}
                      >
                        <TypeIcon n={n} className="mt-0.5 text-muted-foreground" />
                        <button
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            setOpen(false);
                            follow(n);
                          }}
                        >
                          <span className="block text-sm">{headline(n)}</span>
                          {n.excerpt && (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {n.excerpt}
                            </span>
                          )}
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {formatRelativeTime(n.createdAt)}
                          </span>
                        </button>
                        <button
                          onClick={() => feed.dismiss([n.id])}
                          className="invisible self-start rounded p-1 text-muted-foreground hover:bg-muted group-hover:visible"
                          title="Dismiss"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                </section>
              );
            })
          )}
          {hiddenOld > 0 && (
            <p className="px-5 py-4 text-center text-xs text-muted-foreground">
              {hiddenOld} Notifications older than {RETENTION_DAYS} days have been cleared.
            </p>
          )}
        </div>
      </aside>
    </div>
  ) : null;

  return { footer, overlay };
}

// ── controller: one feed, the chosen variant's slots ────────────────────────

export const VARIANTS = [
  { key: "A", name: "Bell dropdown" },
  { key: "B", name: "Feed page, grouped" },
  { key: "C", name: "Drawer by course" },
] as const;

export type PrototypeSlots = {
  header?: ReactNode;
  nav?: ReactNode;
  footer?: ReactNode;
  main?: ReactNode;
  overlay?: ReactNode;
};

export function useNotificationsPrototype(role: string | null): PrototypeSlots {
  const [params] = useSearchParams();
  const variant = params.get("variant") ?? "A";
  const state = (params.get("state") as FeedState) ?? "normal";
  const feed = useFeed(role, state);

  // Hooks for every variant run unconditionally; only the chosen one renders.
  const a = useVariantA({ feed });
  const b = useVariantB({ feed });
  const c = useVariantC({ feed });

  if (!import.meta.env.DEV) return {};
  if (variant === "B") return b;
  if (variant === "C") return c;
  return a;
}
