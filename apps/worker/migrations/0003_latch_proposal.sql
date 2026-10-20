PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_latch_status_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26) NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_latch_status_events`("id", "latch_id", "from_status", "to_status", "created_at") SELECT "id", "latch_id", "from_status", "to_status", "created_at" FROM `latch_status_events`;--> statement-breakpoint
DROP TABLE `latch_status_events`;--> statement-breakpoint
ALTER TABLE `__new_latch_status_events` RENAME TO `latch_status_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `latch_status_events_latch_id_idx` ON `latch_status_events` (`latch_id`);--> statement-breakpoint
ALTER TABLE `latches` ADD `proposed_at` integer;--> statement-breakpoint
CREATE INDEX `latches_status_response_deadline_idx` ON `latches` (`status`,`response_deadline`);--> statement-breakpoint
CREATE INDEX `latches_status_proposed_at_idx` ON `latches` (`status`,`proposed_at`);--> statement-breakpoint
CREATE TABLE `__new_proposal_history` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_low` text(26) NOT NULL,
	`user_high` text(26) NOT NULL,
	`latch_id` text(26),
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_low`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_high`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- 既存行のupdated_atはcreated_atで埋める(NOT NULL列をDEFAULTなしで足すため表を作り直す)
INSERT INTO `__new_proposal_history`("id", "user_low", "user_high", "latch_id", "outcome", "created_at", "updated_at") SELECT "id", "user_low", "user_high", "latch_id", "outcome", "created_at", "created_at" FROM `proposal_history`;--> statement-breakpoint
DROP TABLE `proposal_history`;--> statement-breakpoint
ALTER TABLE `__new_proposal_history` RENAME TO `proposal_history`;--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_history_user_low_user_high_uniq` ON `proposal_history` (`user_low`,`user_high`);--> statement-breakpoint
CREATE INDEX `notifications_user_id_type_created_at_idx` ON `notifications` (`user_id`,`type`,`created_at`);