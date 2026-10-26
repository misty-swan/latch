ALTER TABLE `intents` ADD `jev_held_at` integer;--> statement-breakpoint
ALTER TABLE `intents` ADD `jev_held_reason` text;--> statement-breakpoint
ALTER TABLE `intents` ADD `jev_held_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `intents_status_jev_held_at_idx` ON `intents` (`status`,`jev_held_at`);