CREATE TABLE `config_sync_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_path` text NOT NULL,
	`sync_mode` text DEFAULT 'cluster-synced' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_sync_tags_file_path_unique` ON `config_sync_tags` (`file_path`);
