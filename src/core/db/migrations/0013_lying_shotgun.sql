CREATE TABLE "tournament_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"transient" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_messages_uq" UNIQUE("channel_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "tournament_messages" ADD CONSTRAINT "tournament_messages_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tournament_messages_sweep_idx" ON "tournament_messages" USING btree ("tournament_id","transient");