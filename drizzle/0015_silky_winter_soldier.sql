DROP INDEX `notifications_recipient_created_idx`;--> statement-breakpoint
CREATE INDEX `notifications_recipient_created_idx` ON `notifications` (`recipient_user_id`,"created_at" desc);