ALTER TABLE `refresh_families` ADD `previous_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_families_current_hash_uniq` ON `refresh_families` (`current_hash`);