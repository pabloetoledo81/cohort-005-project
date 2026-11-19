import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema";

// The database types every module that queries takes as its first argument,
// so tests can hand in an in-memory database. Types only: importing this
// opens nothing.

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The database, or a transaction on it. */
export type Queryable = Db | Tx;
