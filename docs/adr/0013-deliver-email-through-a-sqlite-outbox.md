# Deliver email through an outbox table in SQLite

A route never sends email itself. In the same transaction as the event, it writes a pending email Delivery to an outbox table in the app's SQLite file. A poller inside the server process then sends pending Deliveries through Postmark. This is the only option where the event and its email commit or fail together. It also keeps Postmark outages out of the user's request and gives us retries. The Notification Feed is not queued: its Notification is written in the same transaction and shows up immediately.

## Considered Options

- **Send inline after commit** (what the refund routes did). Rejected: a Postmark failure fails the user's action and nothing retries it, and a crash after the commit loses the email.
- **A SQLite queue library.** Rejected. `liteque` needs better-sqlite3 ^13 and opens its own connection, which goes against ADR 0006. `plainjob` and `better-queue-sqlite` look unmaintained. Our version is one table and a small poll loop.
- **Cron alone.** Rejected: cron only starts work, so it would still need a queue. It may still trigger digests later.

## Consequences

- Delivery is at-least-once. A crash after Postmark accepts an email, but before the Delivery is marked sent, sends it twice. We accept that and don't deduplicate.
- Temporary failures are retried with backoff, about 5 attempts. Permanent failures are not retried. A Delivery that ends failed is logged, and no one is alerted.
- This relies on Cadence running as one long-lived server process (see ADR 0006). A serverless or scale-to-zero host would need a different trigger for the poller.
