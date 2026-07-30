CREATE TABLE "progression_season_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"season_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"place" integer NOT NULL,
	"xp" integer NOT NULL,
	"coins_awarded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progression_season_results_uq" UNIQUE("guild_id","season_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "progression_season_rewards" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"champion_role_id" text,
	"top_count" integer DEFAULT 3 NOT NULL,
	"coins_base" integer DEFAULT 100 NOT NULL,
	"announce_channel_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "progression_season_results_season_idx" ON "progression_season_results" USING btree ("guild_id","season_id","place");