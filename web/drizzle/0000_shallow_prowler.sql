CREATE TABLE `access_list_auth` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_list_id` integer NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	FOREIGN KEY (`access_list_id`) REFERENCES `access_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `access_list_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_list_id` integer NOT NULL,
	`address` text NOT NULL,
	`directive` text DEFAULT 'allow' NOT NULL,
	FOREIGN KEY (`access_list_id`) REFERENCES `access_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `access_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`satisfy` text DEFAULT 'any' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`details` text,
	`ip_address` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `config_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_path` text NOT NULL,
	`content` text NOT NULL,
	`change_type` text NOT NULL,
	`user_id` integer,
	`message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_config_versions_file_path` ON `config_versions` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_config_versions_created` ON `config_versions` (`created_at`);--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` integer,
	`host_type` text DEFAULT 'proxy' NOT NULL,
	`upstream` text NOT NULL,
	`status` text NOT NULL,
	`response_ms` integer,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_health_checks_host_time` ON `health_checks` (`host_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `host_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`webhook_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_label_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `host_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `host_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer,
	`domains` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`ssl_type` text DEFAULT 'none' NOT NULL,
	`ssl_force_https` integer DEFAULT false NOT NULL,
	`ssl_cert_path` text,
	`ssl_key_path` text,
	`hsts` integer DEFAULT true NOT NULL,
	`http2` integer DEFAULT true NOT NULL,
	`compression` integer DEFAULT true NOT NULL,
	`redirect_www` integer DEFAULT false NOT NULL,
	`client_max_body_size` text DEFAULT '1m' NOT NULL,
	`locations` text DEFAULT '[]' NOT NULL,
	`stream_ports` text DEFAULT '[]',
	`webhook_url` text,
	`advanced_nginx` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `host_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);