ALTER TABLE `calibration_records` ADD `context` text;--> statement-breakpoint
CREATE UNIQUE INDEX `calibration_records_latch_id_uniq` ON `calibration_records` (`latch_id`);--> statement-breakpoint
CREATE INDEX `calibration_records_anonymized_idx` ON `calibration_records` (`anonymized`);--> statement-breakpoint
ALTER TABLE `latches` ADD `calibrated_at` integer;--> statement-breakpoint
CREATE INDEX `latches_calibrated_at_status_idx` ON `latches` (`calibrated_at`,`status`);