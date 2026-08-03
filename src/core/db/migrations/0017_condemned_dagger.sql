ALTER TABLE "tournament_schedules" ADD COLUMN "auto_teams" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "auto_teams" boolean DEFAULT false NOT NULL;