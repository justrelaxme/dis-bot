CREATE TABLE "progression_achievements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"season_id" integer NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progression_achievements_uq" UNIQUE("guild_id","user_id","code")
);
--> statement-breakpoint
CREATE TABLE "progression_level_rewards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"level" integer NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "progression_level_rewards_uq" UNIQUE("guild_id","level")
);
--> statement-breakpoint
CREATE TABLE "progression_profiles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"season_id" integer NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"coins" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"voice_minutes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progression_profiles_uq" UNIQUE("guild_id","user_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "progression_purchases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"item_id" integer NOT NULL,
	"paid" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progression_seasons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "progression_shop_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"kind" text DEFAULT 'role' NOT NULL,
	"payload" text NOT NULL,
	"title" text NOT NULL,
	"price" integer NOT NULL,
	"duration_hours" integer,
	"enabled" text DEFAULT 'yes' NOT NULL,
	CONSTRAINT "progression_shop_items_uq" UNIQUE("guild_id","payload")
);
--> statement-breakpoint
CREATE TABLE "progression_voice_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progression_voice_sessions_uq" UNIQUE("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"season_id" integer NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "progression_profiles_board_idx" ON "progression_profiles" USING btree ("guild_id","season_id","xp");--> statement-breakpoint
CREATE INDEX "progression_purchases_expiry_idx" ON "progression_purchases" USING btree ("revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "progression_seasons_guild_idx" ON "progression_seasons" USING btree ("guild_id","ended_at");--> statement-breakpoint
CREATE INDEX "xp_events_user_season_idx" ON "xp_events" USING btree ("guild_id","user_id","season_id");--> statement-breakpoint
CREATE INDEX "xp_events_created_idx" ON "xp_events" USING btree ("created_at");