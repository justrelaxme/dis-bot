-- Если гонка уже случилась и открытых сезонов у сервера несколько, живым остаётся самый
-- новый: именно его отдавал currentSeason (сортировка по id по убыванию), значит в нём и
-- копился опыт. Остальные закрываются, иначе уникальный индекс не создастся.
UPDATE "progression_seasons" s SET "ended_at" = now()
WHERE s."ended_at" IS NULL
  AND s."id" <> (SELECT max(o."id") FROM "progression_seasons" o WHERE o."guild_id" = s."guild_id" AND o."ended_at" IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "progression_seasons_open_uq" ON "progression_seasons" USING btree ("guild_id") WHERE "progression_seasons"."ended_at" is null;