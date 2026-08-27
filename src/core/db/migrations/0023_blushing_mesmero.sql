ALTER TABLE "tournament_formats" ADD COLUMN "immunities" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_rosters" ADD COLUMN "immune" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "immunities" integer DEFAULT 0 NOT NULL;