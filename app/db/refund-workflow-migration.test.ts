import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

// Migration 0014 is hand-written (drizzle-kit can't answer its rename prompt
// without a terminal), so check it against data shaped like before it ran.

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

/** A copy of the migrations folder with everything from 0014 on left out. */
function migrationsBefore0014() {
  const folder = mkdtempSync(path.join(tmpdir(), "migrations-"));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 14);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

describe("migration 0014 (refund workflow)", () => {
  it("renames Refund Requests and gives each old approval an Issued Refund", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);

    migrate(db, { migrationsFolder: migrationsBefore0014() });

    sqlite.exec(`
      INSERT INTO users (id, name, email, role, created_at) VALUES
        (1, 'Buyer', 'b@example.com', 'student', '2026-01-01'),
        (2, 'Teacher', 't@example.com', 'instructor', '2026-01-01');
      INSERT INTO categories (id, name, slug) VALUES (1, 'C', 'c');
      INSERT INTO courses (id, title, slug, description, sales_copy, instructor_id, category_id, status, created_at, updated_at)
        VALUES (1, 'Course', 'course', 'd', 's', 2, 1, 'published', '2026-01-01', '2026-01-01');
      INSERT INTO purchases (id, user_id, course_id, amount_paid, created_at) VALUES
        (1, 1, 1, 7900, '2026-01-01'), (2, 1, 1, 7900, '2026-01-02');
      INSERT INTO refunds (id, purchase_id, status, reason, amount_refunded, requested_at, resolved_at) VALUES
        (1, 1, 'approved', 'r', 7900, '2026-01-03', '2026-01-04'),
        (2, 2, 'declined', 'r', NULL, '2026-01-05', '2026-01-06');
      INSERT INTO notifications (recipient_user_id, type, text, href, refund_request_id, created_at)
        VALUES (1, 'refund_request_approved', 't', '/settings', 1, '2026-01-04');
    `);

    migrate(db, { migrationsFolder });

    expect(sqlite.prepare("SELECT id, status FROM refund_requests ORDER BY id").all()).toEqual([
      { id: 1, status: "approved" },
      { id: 2, status: "declined" },
    ]);
    expect(
      sqlite
        .prepare("SELECT refund_request_id, approved_amount, status, issued_at FROM refunds")
        .all()
    ).toEqual([
      { refund_request_id: 1, approved_amount: 7900, status: "issued", issued_at: "2026-01-04" },
    ]);
    const columns = sqlite
      .prepare("SELECT name FROM pragma_table_info('refund_requests')")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).not.toContain("amount_refunded");

    // The Notification's reference followed the rename.
    const fk = sqlite
      .prepare("SELECT \"table\" FROM pragma_foreign_key_list('notifications') WHERE \"from\" = 'refund_request_id'")
      .get() as { table: string };
    expect(fk.table).toBe("refund_requests");
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
