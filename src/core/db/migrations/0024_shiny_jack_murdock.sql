CREATE TABLE "tournament_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"organizer_role_id" text,
	"staff_channel_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_schedules" ADD COLUMN "cost_cap" integer;--> statement-breakpoint
ALTER TABLE "tournament_schedules" ADD COLUMN "immunities" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "closed_out_at" timestamp with time zone;--> statement-breakpoint
-- Прошлые турниры уже закрыты — в Discord за ними убрали, итог объявили или объявлять
-- было нечего. Без этой отметки синхронизатор счёл бы всю историю незакрытой и объявил бы
-- каждый турнир заново.
UPDATE "tournaments" SET "closed_out_at" = coalesce("finished_at", now()) WHERE "state" IN ('finished', 'cancelled');
