CREATE TABLE "tournament_rosters" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"external_id" text,
	"characters" jsonb NOT NULL,
	"spent" double precision NOT NULL,
	"cap" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_rosters_tournament_user_uq" UNIQUE("tournament_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tournament_rosters" ADD CONSTRAINT "tournament_rosters_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;