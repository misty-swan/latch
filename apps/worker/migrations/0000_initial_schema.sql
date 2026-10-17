CREATE TABLE `blocks` (
	`blocker_user_id` text(26) NOT NULL,
	`blocked_user_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_user_id`, `blocked_user_id`)
);
--> statement-breakpoint
CREATE TABLE `calibration_records` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26),
	`form` text NOT NULL,
	`prediction` text NOT NULL,
	`outcome` text NOT NULL,
	`action` text NOT NULL,
	`survey` text,
	`anonymized` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_reads` (
	`latch_id` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	`last_read_message_id` text(26) NOT NULL,
	PRIMARY KEY(`latch_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `geofeatures` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`municipality` text NOT NULL,
	`type` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`grid_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `geofeatures_grid_key_idx` ON `geofeatures` (`grid_key`);--> statement-breakpoint
CREATE TABLE `group_candidates` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`intent_ids` text NOT NULL,
	`dedup_key` text NOT NULL,
	`aggregate_score` real NOT NULL,
	`prev_aggregate_score` real,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_candidates_dedup_key_uniq` ON `group_candidates` (`dedup_key`);--> statement-breakpoint
CREATE TABLE `intents` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_id` text(26) NOT NULL,
	`form` text,
	`topic` text,
	`category` text,
	`raw_text` text NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`geo_center_lat` real,
	`geo_center_lng` real,
	`geo_radius_m` integer,
	`participants_min` integer NOT NULL,
	`participants_max` integer NOT NULL,
	`participants_includes_owner` integer NOT NULL,
	`budget_min` integer,
	`budget_max` integer,
	`currency` text,
	`hard_constraints` text NOT NULL,
	`soft_constraints` text NOT NULL,
	`negative_constraints` text NOT NULL,
	`visibility` text NOT NULL,
	`notification_level` text NOT NULL,
	`alcohol_involved` integer NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`expires_at` integer,
	`embedding_model` text,
	`embedded_at` integer,
	`last_evaluated_at` integer,
	`vector_deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intents_user_id_status_idx` ON `intents` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `intents_status_form_category_idx` ON `intents` (`status`,`form`,`category`);--> statement-breakpoint
CREATE INDEX `intents_status_starts_at_idx` ON `intents` (`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `intents_status_expires_at_idx` ON `intents` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `latch_feedback` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `latch_feedback_latch_id_user_id_kind_uniq` ON `latch_feedback` (`latch_id`,`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `latch_members` (
	`latch_id` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	PRIMARY KEY(`latch_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `latch_members_user_id_latch_id_idx` ON `latch_members` (`user_id`,`latch_id`);--> statement-breakpoint
CREATE TABLE `latch_responses` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	`response` text NOT NULL,
	`defer_reason` text,
	`responded_at` integer NOT NULL,
	`retracted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `latch_responses_latch_id_user_id_uniq` ON `latch_responses` (`latch_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `latch_status_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26) NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `latches` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`form` text NOT NULL,
	`intent_ids` text NOT NULL,
	`proposal` text NOT NULL,
	`score` real NOT NULL,
	`status` text NOT NULL,
	`response_deadline` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `latches_status_form_last_message_at_idx` ON `latches` (`status`,`form`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `match_candidates` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`intent_a_id` text(26) NOT NULL,
	`intent_b_id` text(26) NOT NULL,
	`intent_a_version` integer NOT NULL,
	`intent_b_version` integer NOT NULL,
	`form` text NOT NULL,
	`retrieval_score` real,
	`cheap_judge_score` real,
	`jev_result` text,
	`latch_score` real,
	`prev_latch_score` real,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`intent_a_id`) REFERENCES `intents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_b_id`) REFERENCES `intents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_candidates_intent_pair_versions_uniq` ON `match_candidates` (`intent_a_id`,`intent_b_id`,`intent_a_version`,`intent_b_version`);--> statement-breakpoint
CREATE INDEX `match_candidates_intent_a_id_idx` ON `match_candidates` (`intent_a_id`);--> statement-breakpoint
CREATE INDEX `match_candidates_intent_b_id_idx` ON `match_candidates` (`intent_b_id`);--> statement-breakpoint
CREATE TABLE `match_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`source_intent_id` text(26) NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`source_intent_id`) REFERENCES `intents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_events_event_type_source_intent_id_version_uniq` ON `match_events` (`event_type`,`source_intent_id`,`version`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`latch_id` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_latch_id_id_idx` ON `messages` (`latch_id`,`id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_id` text(26) NOT NULL,
	`type` text NOT NULL,
	`latch_id` text(26),
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_user_id_read_at_id_idx` ON `notifications` (`user_id`,`read_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_latch_id_user_id_type_uniq` ON `notifications` (`latch_id`,`user_id`,`type`);--> statement-breakpoint
CREATE TABLE `proposal_history` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_low` text(26) NOT NULL,
	`user_high` text(26) NOT NULL,
	`latch_id` text(26),
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_low`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_high`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latch_id`) REFERENCES `latches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_history_user_low_user_high_uniq` ON `proposal_history` (`user_low`,`user_high`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_id` text(26) NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`status` text NOT NULL,
	`last_success_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uniq` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `refresh_families` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_id` text(26) NOT NULL,
	`current_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`reporter` text(26) NOT NULL,
	`reportee` text(26) NOT NULL,
	`reason` text NOT NULL,
	`latch_id` text(26),
	`note` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_id` text(26) NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `survey_responses` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`user_id` text(26) NOT NULL,
	`kind` text NOT NULL,
	`answers` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `survey_responses_user_id_kind_uniq` ON `survey_responses` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`auth_provider` text NOT NULL,
	`auth_subject` text NOT NULL,
	`actor_type` text NOT NULL,
	`display_name` text NOT NULL,
	`bio` text NOT NULL,
	`icon_key` text,
	`birth_date` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_provider_auth_subject_uniq` ON `users` (`auth_provider`,`auth_subject`);