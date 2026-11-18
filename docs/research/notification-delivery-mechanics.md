# Notification delivery mechanics on single-process SQLite

Research for [#9](https://github.com/pabloetoledo81/cohort-005-project/issues/9) (child of map [#2](https://github.com/pabloetoledo81/cohort-005-project/issues/2)). This document lists the options and their trade-offs. It does not choose one; a later ticket makes that decision.

Researched 2026-11-18 against the local `main` checkout. The pushed `origin/main` is still at the initial commit; the files cited below exist in local `main` only.

## 1. What the repo has today

- **Database ([ADR 0006](../adr/0006-one-sqlite-file-through-drizzle.md)):**
  - Cadence "runs as one server process". Its data is in one SQLite file, `data.db`, opened with `better-sqlite3` and queried through Drizzle.
  - Consequences the ADR records: "There is one writer at a time, and the app cannot run on more than one machine against the same data." Moving to a networked database would mean "making every synchronous query async".
  - `app/db/index.ts` sets `journal_mode = WAL` and `foreign_keys = ON`, and pins no `busy_timeout`. `package.json` allows the `better-sqlite3@12.11.1` install script and declares `drizzle-orm ^0.45.2`.
- **Server process:** `npm start` runs `react-router-serve ./build/server/index.js` (`package.json`). That is one Node process. No cluster or worker setup is configured.
- **Email today (`app/lib/mailer.server.ts`):**
  - `sendEmail(email, transport = defaultTransport())` uses `postmarkTransport` when `POSTMARK_SERVER_TOKEN` is set. That transport does a `fetch` POST to `https://api.postmarkapp.com/email` and throws on a non-OK response. Otherwise it uses `outboxTransport(".outbox")`, which writes one JSON file per message.
  - The transport has no retry and no request timeout.
- **Inline call sites:**
  - `app/routes/courses.$slug.refund.ts` calls `raiseRefundRequest(...)` (in `app/lib/refunds.server.ts`, which inserts the request without `db.transaction`), then `await sendEmail(result.email)`, then redirects.
  - `app/routes/admin.refunds.tsx` calls `approveRefundRequest` or `declineRefundRequest`. Each wraps its writes in `db.transaction(...)` and returns the email built inside it. The route then does `await sendEmail(result.email)` *after* the transaction has committed.
  - So in both flows the email is sent in the request, after the DB commit. Reading the code, this has two consequences:
    - If Postmark fails, `sendEmail` throws. The user's action errors even though the refund state has already been written, and the email is not retried.
    - If the process dies between the commit and the send, the email is lost silently.
- **Deployment config:** none. The main checkout has no `Dockerfile`, `fly.toml`, `render.yaml`, `Procfile`, `docker-compose*`, `railway.*`, `nixpacks.toml` or `.github/workflows/*`. The only Dockerfile in the repo is `.sandcastle/Dockerfile`, which builds the agent sandbox (`ENTRYPOINT ["sleep", "infinity"]`), not the app. **The deployment target is unknown.** Beyond what ADR 0006 states (one process, one machine), several trade-offs below depend on it: whether the host keeps a long-lived process, whether the disk is persistent, and whether it offers platform cron.

## 2. Constraints that come from SQLite itself

These apply to every option, from the [SQLite WAL documentation](https://www.sqlite.org/wal.html):

- **One writer at a time.** "since there is only one WAL file, there can only be one writer at a time." Readers and writers don't block each other: "writers do not block readers and readers do not block writers. This is mostly true." A queue or outbox that writes on every claim and completion competes with request writes for that single writer slot.
- **One host only.** "All processes using a database must be on the same host computer; WAL does not work over a network filesystem." Several app instances on separate machines can't share `data.db`. Running more than one instance means changing the database (out of scope for this ticket), not choosing a different queue.
- **Long readers block checkpoints.** "a long-running read transaction can prevent a checkpointer from making progress," and the WAL file then "will grow without bound." A poller that holds a read open while it sends email over the network would cause this.
- **Transactions are synchronous.** From the [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md): "Transaction functions do not work with async functions … the transaction will already be committed before any async code executes." Network I/O such as calling an email API **cannot** happen inside the DB transaction. The pattern is to write rows in the transaction and send after commit. Nested transaction calls become savepoints.

## 3. The options

### (a) Inline in the request

The action writes its rows and then calls the email transport, and the in-app notification insert, before returning. Both refund routes do this today with `await sendEmail(...)`.

- **Retries:** none, unless you write an in-request retry loop, and that adds latency to the user's request.
- **Failure isolation:** poor.
  - An email provider outage or timeout either fails the user's action or is swallowed and lost.
  - Because the send can't be inside the better-sqlite3 transaction, a crash between commit and send loses the notification silently.
  - Postmark latency adds directly to the response time, because `postmarkTransport` sets no fetch timeout.
  - The in-app insert can be put in the same transaction as the business write. That is cheap and atomic.
- **Scheduling (digests):** none. Digests need something that runs on a timer, so this option needs (b), (c) or (d) for them anyway.
- **Multi-instance:** not a concern, because nothing is shared.
- **Operational cost:** lowest. No new tables, no new processes.

### (b) Transactional outbox table plus an in-process poller

In the same `db.transaction` as the business write, insert one row per delivery (Notification × Channel) into an `outbox` or `notification_deliveries` table. A poller in the same Node process (a `setInterval`/`setTimeout` loop started at server boot) claims due rows, sends them outside any transaction, and marks them sent, or reschedules them with backoff.

This is the [transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html): "saves each message in an outbox table within the same database transaction that updates its business data", with a relay that forwards it.

- **Retries:** yes. You design them: attempt count, `next_attempt_at` and backoff columns.
  - The pattern's own caveat: the relay "might publish a message more than once" (it crashes after sending but before marking the row), so "a message consumer must be idempotent."
  - For email, this means rare duplicates unless the provider supports an idempotency key. This research did not verify Postmark's support for one.
- **Failure isolation:** good. The user's request only does local SQLite inserts, and provider outages show up as rows waiting to be retried.
- **Scheduling (digests):** natural. A row with a future `deliver_at`, or a digest row that a periodic sweep rolls up, is just more outbox data. A small timer covers the recurring trigger: plain `setInterval`, or a cron library like the ones in (d).
- **Multi-instance:** safe on one host if rows are claimed with a single atomic `UPDATE … WHERE status='pending' … RETURNING`. Because SQLite allows one writer, the claim serializes naturally. Several hosts aren't possible with SQLite in any case (section 2).
- **Operational cost:** low.
  - Costs: one table and its migration (this repo uses `drizzle-kit`), roughly 100–200 lines of claim/send/backoff code, and a boot hook to start the poller.
  - Watch-outs: the poller must not hold a read transaction during network I/O (WAL checkpoints), and it should stop cleanly on shutdown.
  - The table doubles as the per-Channel delivery record that map #2 lists under "Notification data model and storage".
  - It also depends on the host keeping the process alive. A scale-to-zero platform would pause the poller.

### (c) An existing SQLite-backed job queue library

I checked the npm registry, GitHub and the GitHub Advisory Database for each library below (all on 2026-11-18).

| Package | Latest (npm) | Released | Repo activity | Weekly downloads | Advisories |
| --- | --- | --- | --- | --- | --- |
| [`liteque`](https://www.npmjs.com/package/liteque) ([repo](https://github.com/karakeep-app/liteque)) | 0.10.0 | 2026-10-10 | pushed 2026-10-10, 80 stars, not archived | ~2.3k | none found |
| [`plainjob`](https://www.npmjs.com/package/plainjob) ([repo](https://github.com/justplainstuff/plainjob)) | 0.0.14 | 2024-10-13 | last non-bot commit 2024-10-13; since then only Renovate dependency bumps; 99 stars, 13 open issues | ~240 | none found |
| [`better-queue`](https://www.npmjs.com/package/better-queue) + [`better-queue-sqlite`](https://www.npmjs.com/package/better-queue-sqlite) ([repo](https://github.com/diamondio/better-queue-sqlite)) | 3.8.12 / 1.0.7 | 2022-09-22 / 2022-10-13 | sqlite store repo last pushed 2023-03-13 | ~131k / ~1.1k | none found |

Sources: `https://registry.npmjs.org/<pkg>`, `https://api.npmjs.org/downloads/point/last-week/<pkg>`, `gh api repos/<owner>/<repo>`, `gh api /advisories?ecosystem=npm&affects=<pkg>`. "None found" means only that the GitHub Advisory Database returned no entries. I did not check other CVE databases (Snyk, OSV).

**liteque** (from its [README](https://github.com/karakeep-app/liteque) and source `src/queue.ts`, `src/db.ts`, `src/options.ts`):

- **Features:** per-job `numRetries`, `delayMs`, `priority` and `idempotencyKey`, with an `onConflictDoNothing` dedupe. The runner has `pollIntervalMs`, `timeoutSecs` and `concurrency`. Expired `running` jobs are reclaimed. It is built on Drizzle and Zod.
- **No cron or recurring schedule** appears in its options, so digests would still need a timer.
- **Version conflict:** since 0.9.0 its peer dependency is `better-sqlite3 ^13.0.3`. This repo locks 12.11.1, so adopting the current release means a better-sqlite3 major upgrade. 0.8.0 and earlier declared `>=7`.
- **It opens its own connection** (`buildDBClient(path)`) and ships its own Drizzle migrations. So:
  - Enqueueing is **not** in the same transaction as the app's business write. You lose outbox atomicity unless you add an outbox in front of it.
  - If you point it at `data.db`, its migrations would share the file with the app's `drizzle-kit` migrations. Whether the two migration journals collide is an inference I did not test.
- It is a 0.x library maintained by the Karakeep project.

**plainjob** (from its [README](https://github.com/justplainstuff/plainjob) and source `src/queue.ts`, `src/worker.ts`):

- **Features:** you pass it an existing `better-sqlite3` connection (`better(new Database(...))`). It has delayed jobs, cron-scheduled recurring jobs (`queue.schedule(type, { cron })`, using `cron-parser`), timed-out job requeueing, and cleanup of old done and failed jobs.
- **Retries:** I found no automatic retry on failure. The worker calls `markJobAsFailed` and only *timed-out* jobs are requeued, so retry policy would be your own code.
- **Transactions:** because it takes the app's connection, enqueueing inside the app's `db.transaction` may work. That is an inference from the API shape that I did not test.
- **Maintenance:** no release in about two years; still 0.0.x.

**better-queue + better-queue-sqlite:**

- The SQLite store depends on the `sqlite3` package, not `better-sqlite3`. That adds a second native SQLite binding and a separate connection.
- Both packages have had no release since 2022.

General trade-offs of (c) compared with (b):

- **Pros:** retry, timeout and claim logic already exist.
- **Cons:**
  - A young (0.x) dependency on the delivery path.
  - Its own schema, outside `app/db/schema.ts` and `drizzle-kit`.
  - Possible version coupling with `better-sqlite3` and `drizzle-orm`.
  - It usually doesn't remove the need for an outbox row if enqueueing must be atomic with the business write.
- **Multi-instance and host constraints:** identical to (b), because the SQLite limits still apply.

### (d) External scheduler or cron

A trigger outside the request path calls the app on a schedule:

- an OS or platform cron job runs a `tsx scripts/...` command against `data.db`, or
- it hits an authenticated internal route that drains or digests.

In-process cron libraries are the lightweight cousin: [`croner`](https://www.npmjs.com/package/croner) (11.0.1, released 2026-11-14, [repo](https://github.com/Hexagon/croner) active) and [`node-cron`](https://www.npmjs.com/package/node-cron) (4.6.0, released 2026-07-05, [repo](https://github.com/node-cron/node-cron) active). Both are MIT-licensed with millions of weekly downloads, and the GitHub Advisory Database has no advisories for either.

- **Retries:** none by itself. It only triggers. Retries come from the table it drains, which is (b).
- **Failure isolation:** good, because it runs outside the request.
- **Scheduling (digests):** the strongest fit. Cron expressions express "daily at 08:00" directly.
- **Multi-instance:** an external cron fires once regardless of instance count. An in-process cron library fires once *per process*, so it needs a DB-level claim if there were ever more than one process.
- **Operational cost:**
  - An external cron needs a deployment that supports it, and none is defined (section 1).
  - A CLI script would open `data.db` from a second process. That is allowed in WAL mode on the same host, but it competes for the single writer.
  - An in-process cron library costs only one small dependency.
  - On its own, (d) can't deliver event-driven Notifications promptly: a 1-minute cron means up to a minute of latency. It complements (b) or (c) rather than replacing them.

## 4. Side-by-side

| | (a) Inline | (b) Outbox + in-process poller | (c) SQLite queue library | (d) External / cron trigger |
| --- | --- | --- | --- | --- |
| Retries | none | yes, your own backoff; at-least-once, possible duplicates | liteque: built in; plainjob: timeout requeue only | none by itself |
| Isolation from user request | poor: provider latency and failures hit the request; crash after commit loses sends | good: only local inserts in the request | good | good |
| Atomic with business write | in-app yes, email no | yes, same `db.transaction` | liteque no (own connection); plainjob possibly, untested | n/a |
| Digest scheduling | no | yes, via `deliver_at` rows plus a timer | plainjob cron; liteque delay only | best fit |
| Multi-instance | n/a | safe on one host with an atomic claim; SQLite rules out several hosts | same as (b) | external cron: fires once; in-process: once per process |
| Ops cost | none | one table, small worker, long-lived process | dependency, separate schema, version coupling (liteque needs better-sqlite3 13) | depends on an undefined deployment; in-process lib is cheap |

## 5. Open questions for the decision ticket

1. Local `main` is ahead of `origin/main`. The files cited here aren't on GitHub yet, so the links won't resolve until local `main` is pushed.
2. What is the deployment target? Specifically: does it keep a long-lived process (needed by (b), (c) and in-process cron), is the disk persistent, and does it offer a platform cron?
3. Are rare duplicate emails acceptable (at-least-once), or must sends be deduplicated with a provider idempotency key? Postmark's support for one was not verified here.
4. Should the outbox or delivery table double as the per-Channel delivery record that map #2 lists under "Notification data model and storage"?
