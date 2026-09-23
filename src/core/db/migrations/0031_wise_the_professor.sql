CREATE TABLE "circuit_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"game" text NOT NULL,
	"place" integer NOT NULL,
	"place_to" integer NOT NULL,
	"field_size" integer NOT NULL,
	"points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circuit_points_uq" UNIQUE("season_id","tournament_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "circuit_seasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"champion_user_id" text,
	"champion_name" text
);
--> statement-breakpoint
ALTER TABLE "circuit_points" ADD CONSTRAINT "circuit_points_season_id_circuit_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."circuit_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_points" ADD CONSTRAINT "circuit_points_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "circuit_points_season_idx" ON "circuit_points" USING btree ("season_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "circuit_seasons_open_uq" ON "circuit_seasons" USING btree ("guild_id") WHERE "circuit_seasons"."closed_at" is null;