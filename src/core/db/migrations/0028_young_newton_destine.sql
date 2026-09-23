CREATE TABLE "prediction_boards" (
	"tournament_id" integer PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_cards" (
	"match_id" integer PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_predictions" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prediction_boards" ADD CONSTRAINT "prediction_boards_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_cards" ADD CONSTRAINT "prediction_cards_match_id_tournament_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."tournament_matches"("id") ON DELETE cascade ON UPDATE no action;