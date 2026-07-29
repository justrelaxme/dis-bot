CREATE TABLE "moderation_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"log_channel_id" text,
	"mute_role_id" text,
	"antispam_enabled" text DEFAULT 'yes' NOT NULL,
	"spam_messages" integer DEFAULT 6 NOT NULL,
	"spam_window_seconds" integer DEFAULT 8 NOT NULL,
	"spam_duplicates" integer DEFAULT 4 NOT NULL,
	"spam_mentions" integer DEFAULT 6 NOT NULL,
	"spam_mute_minutes" integer DEFAULT 10 NOT NULL,
	"antiraid_enabled" text DEFAULT 'yes' NOT NULL,
	"raid_joins" integer DEFAULT 8 NOT NULL,
	"raid_window_seconds" integer DEFAULT 30 NOT NULL,
	"warns_to_mute" integer DEFAULT 3 NOT NULL,
	"warn_mute_minutes" integer DEFAULT 60 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_infractions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"moderator_id" text,
	"kind" text NOT NULL,
	"source" text DEFAULT 'moderator' NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_tickets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"topic" text NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "moderation_infractions_user_idx" ON "moderation_infractions" USING btree ("guild_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_infractions_expiry_idx" ON "moderation_infractions" USING btree ("lifted_at","expires_at");--> statement-breakpoint
CREATE INDEX "moderation_tickets_user_idx" ON "moderation_tickets" USING btree ("guild_id","user_id","closed_at");