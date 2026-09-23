CREATE TABLE "weekly_recaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"week_of" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_recaps_week_uq" UNIQUE("guild_id","week_of")
);
