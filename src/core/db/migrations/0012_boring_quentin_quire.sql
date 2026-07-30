CREATE TABLE "tournament_draft_choices" (
	"id" serial PRIMARY KEY NOT NULL,
	"draft_id" integer NOT NULL,
	"step" integer NOT NULL,
	"side" text NOT NULL,
	"kind" text NOT NULL,
	"option_id" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_draft_choices_step_uq" UNIQUE("draft_id","step")
);
--> statement-breakpoint
CREATE TABLE "tournament_match_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"subject" text NOT NULL,
	"pool" jsonb NOT NULL,
	"sequence" jsonb NOT NULL,
	"token_a" text NOT NULL,
	"token_b" text NOT NULL,
	"deadline_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_match_drafts_match_uq" UNIQUE("match_id"),
	CONSTRAINT "tournament_match_drafts_token_a_uq" UNIQUE("token_a"),
	CONSTRAINT "tournament_match_drafts_token_b_uq" UNIQUE("token_b")
);
--> statement-breakpoint
ALTER TABLE "tournament_draft_choices" ADD CONSTRAINT "tournament_draft_choices_draft_id_tournament_match_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."tournament_match_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_match_drafts" ADD CONSTRAINT "tournament_match_drafts_match_id_tournament_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."tournament_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_match_drafts" ADD CONSTRAINT "tournament_match_drafts_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tournament_match_drafts_due_idx" ON "tournament_match_drafts" USING btree ("completed_at","deadline_at");