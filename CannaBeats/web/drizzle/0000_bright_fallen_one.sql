CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host_token` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
