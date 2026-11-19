-- The table called `refunds` held Refund Requests. Rename it to match the
-- glossary, then add `refunds` for the money. SQLite rewrites foreign keys
-- that point at a renamed table (notifications.refund_request_id).
ALTER TABLE `refunds` RENAME TO `refund_requests`;
--> statement-breakpoint
DROP INDEX `refunds_purchase_idx`;
--> statement-breakpoint
CREATE INDEX `refund_requests_purchase_idx` ON `refund_requests` (`purchase_id`);
--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_request_id` integer NOT NULL,
	`approved_amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`failure_reason` text,
	`provider_reference` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`issued_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_refund_request_id_unique` ON `refunds` (`refund_request_id`);
--> statement-breakpoint
-- Approvals from before Refunds were tracked: their money was paid by hand,
-- outside Cadence, so record them as Issued rather than leave them to be
-- paid again.
INSERT INTO `refunds` (`refund_request_id`, `approved_amount`, `status`, `attempts`, `issued_at`, `created_at`)
SELECT `id`, `amount_refunded`, 'issued', 0, `resolved_at`, COALESCE(`resolved_at`, `requested_at`)
FROM `refund_requests`
WHERE `status` = 'approved' AND `amount_refunded` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `refund_requests` DROP COLUMN `amount_refunded`;
