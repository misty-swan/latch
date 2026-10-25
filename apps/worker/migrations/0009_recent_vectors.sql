CREATE TABLE `recent_vectors` (
	`intent_id` text(26) PRIMARY KEY NOT NULL,
	`embedded_at` integer NOT NULL,
	`vector` blob NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `intents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recent_vectors_embedded_at_idx` ON `recent_vectors` (`embedded_at`);