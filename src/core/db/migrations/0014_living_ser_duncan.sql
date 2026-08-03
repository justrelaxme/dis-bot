ALTER TABLE "tournament_schedules" ADD COLUMN "abilities" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "abilities" boolean DEFAULT true NOT NULL;