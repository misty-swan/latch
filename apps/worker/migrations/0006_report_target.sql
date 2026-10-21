ALTER TABLE `reports` ADD `target` text NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `message_id` text(26);--> statement-breakpoint
CREATE INDEX `reports_reporter_latch_id_reportee_target_status_idx` ON `reports` (`reporter`,`latch_id`,`reportee`,`target`,`status`);