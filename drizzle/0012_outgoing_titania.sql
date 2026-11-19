CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer NOT NULL,
	`channel` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`mandatory` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`provider_message_id` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_notification_channel_unique` ON `notification_deliveries` (`notification_id`,`channel`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_due_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_user_id` integer NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`href` text NOT NULL,
	`comment_id` integer,
	`refund_request_id` integer,
	`created_at` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_created_idx` ON `notifications` (`recipient_user_id`,`created_at`);