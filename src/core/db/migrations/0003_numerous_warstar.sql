CREATE TABLE "tournament_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"cycle_date" date NOT NULL,
	"stage" text DEFAULT 'poll' NOT NULL,
	"poll_id" integer,
	"tournament_id" integer,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_cycles_day_uq" UNIQUE("guild_id","cycle_date")
);
--> statement-breakpoint
CREATE TABLE "tournament_entrant_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"entrant_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'player' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_members_entrant_user_uq" UNIQUE("entrant_id","user_id"),
	CONSTRAINT "tournament_members_tournament_user_uq" UNIQUE("tournament_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_entrants" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"display_name" text NOT NULL,
	"captain_user_id" text NOT NULL,
	"seed" integer,
	"seed_score" integer,
	"checked_in_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"voice_channel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_entrants_name_uq" UNIQUE("tournament_id","display_name"),
	CONSTRAINT "tournament_entrants_captain_uq" UNIQUE("tournament_id","captain_user_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_match_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"actor_id" text NOT NULL,
	"claimed_winner_id" integer,
	"action" text NOT NULL,
	"by_organizer" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"round" integer NOT NULL,
	"slot" integer NOT NULL,
	"entrant_a_id" integer,
	"entrant_b_id" integer,
	"winner_entrant_id" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"reported_by" text,
	"reported_winner_id" integer,
	"reported_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_matches_position_uq" UNIQUE("tournament_id","round","slot")
);
--> statement-breakpoint
CREATE TABLE "tournament_schedules" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"poll_at" text DEFAULT '14:00' NOT NULL,
	"poll_hours" integer DEFAULT 2 NOT NULL,
	"start_at" text DEFAULT '20:00' NOT NULL,
	"entry_mode" text DEFAULT 'team' NOT NULL,
	"team_size" integer DEFAULT 5 NOT NULL,
	"max_entrants" integer DEFAULT 16 NOT NULL,
	"best_of" integer DEFAULT 1 NOT NULL,
	"require_verified" boolean DEFAULT true NOT NULL,
	"games" jsonb NOT NULL,
	"announce_channel_id" text,
	"team_category_id" text,
	"match_parent_id" text,
	"empty_days" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"game" text NOT NULL,
	"format" text DEFAULT 'single-elim' NOT NULL,
	"entry_mode" text NOT NULL,
	"team_size" integer DEFAULT 1 NOT NULL,
	"max_entrants" integer DEFAULT 16 NOT NULL,
	"seeding" text DEFAULT 'rank' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"best_of" integer DEFAULT 1 NOT NULL,
	"require_verified" boolean DEFAULT true NOT NULL,
	"announce_channel_id" text,
	"team_category_id" text,
	"match_parent_id" text,
	"created_by" text NOT NULL,
	"registration_closes_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_entrant_members" ADD CONSTRAINT "tournament_entrant_members_entrant_id_tournament_entrants_id_fk" FOREIGN KEY ("entrant_id") REFERENCES "public"."tournament_entrants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entrant_members" ADD CONSTRAINT "tournament_entrant_members_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entrants" ADD CONSTRAINT "tournament_entrants_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_match_reports" ADD CONSTRAINT "tournament_match_reports_match_id_tournament_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."tournament_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tournament_entrants_tournament_idx" ON "tournament_entrants" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "tournament_matches_reported_idx" ON "tournament_matches" USING btree ("state","reported_at");--> statement-breakpoint
CREATE INDEX "tournaments_guild_state_idx" ON "tournaments" USING btree ("guild_id","state");