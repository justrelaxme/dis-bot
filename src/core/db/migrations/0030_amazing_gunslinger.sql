CREATE TABLE "cast_states" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"tournament_id" integer,
	"scene" text DEFAULT 'auto' NOT NULL,
	"featured_match_id" integer,
	"countdown_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
