ALTER TABLE `latch_members` ADD `hidden_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `client_id` text(64);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_latch_id_user_id_client_id_uq` ON `messages` (`latch_id`,`user_id`,`client_id`);