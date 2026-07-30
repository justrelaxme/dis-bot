CREATE TABLE "welcome_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" text,
	"dm_enabled" boolean DEFAULT true NOT NULL,
	"auto_role_id" text,
	"rules_channel_id" text,
	"tournament_channel_id" text,
	"greeting" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
