ALTER TABLE "tournament_match_drafts" ADD COLUMN "armed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "announced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "present_a_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "present_b_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "confirm_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD COLUMN "dispute_reason" text;--> statement-breakpoint
-- Драфты, идущие в момент обновления, уже со своим таймером: без отметки они встали бы,
-- ожидая «На месте», которого в старой ветке матча никто не видел.
UPDATE "tournament_match_drafts" SET "armed_at" = "created_at" WHERE "completed_at" IS NULL;--> statement-breakpoint
-- Матчи, уже идущие в момент обновления, карточку «матч готов» не получат: ветка у них есть,
-- соперники договорились. Карточка — только тем, кто станет играбельным после обновления.
UPDATE "tournament_matches" SET "announced_at" = now(), "live_at" = now() WHERE "state" IN ('ready', 'reported', 'disputed') AND "thread_id" IS NOT NULL;
