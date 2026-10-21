ALTER TABLE `notifications` ADD `intent_id` text(26);--> statement-breakpoint
ALTER TABLE `notifications` ADD `push_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `push_attempted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_intent_id_type_uniq` ON `notifications` (`intent_id`,`type`);--> statement-breakpoint
CREATE INDEX `notifications_push_state_created_at_idx` ON `notifications` (`push_state`,`created_at`);