CREATE TABLE "tournament_polls" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"options" jsonb NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"winner_game" text,
	"finalized_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_polls_message_uq" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE INDEX "tournament_polls_due_idx" ON "tournament_polls" USING btree ("finalized_at","closes_at");