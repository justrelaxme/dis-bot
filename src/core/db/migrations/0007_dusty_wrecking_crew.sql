ALTER TABLE "tournament_matches" DROP CONSTRAINT "tournament_matches_position_uq";--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "bracket" text DEFAULT 'upper' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_schedules" ADD COLUMN "format" text DEFAULT 'single-elim' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_position_uq" UNIQUE("tournament_id","bracket","round","slot");