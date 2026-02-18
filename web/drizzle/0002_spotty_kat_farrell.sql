CREATE TABLE `cluster_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text NOT NULL,
	`role` text DEFAULT 'worker' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cluster_nodes_url_unique` ON `cluster_nodes` (`url`);