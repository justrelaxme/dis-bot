CREATE TABLE "match_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entrant_id" integer NOT NULL,
	"settled_at" timestamp with time zone,
	"coins_awarded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_predictions_user_uq" UNIQUE("match_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "match_predictions" ADD CONSTRAINT "match_predictions_match_id_tournament_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."tournament_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_predictions_settle_idx" ON "match_predictions" USING btree ("settled_at","match_id");--> statement-breakpoint
CREATE INDEX "match_predictions_board_idx" ON "match_predictions" USING btree ("guild_id","user_id");