CREATE TABLE `custom_templates` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `category` text NOT NULL DEFAULT 'custom',
  `content` text NOT NULL,
  `variables` text,
  `user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL
);
