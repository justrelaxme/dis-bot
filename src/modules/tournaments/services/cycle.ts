import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import type { Logger } from '../../../core/logger.js';
import { EVENT_SIZE_LABELS, eventSize } from '../bracket.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import {
  tournamentCycles,
  tournamentSchedules,
  type CycleRow,
  type ScheduleRow,
  type TournamentGame,
} from '../schema.js';

/** Сколько дней подряд без участников терпим, прежде чем встать на паузу. */
export const EMPTY_DAYS_LIMIT = 3;

export interface CycleServiceDeps {
  db: Database;
  logger: Logger;
}

/**
 * Локальные дата и время в заданном часовом поясе. Без библиотеки: `Intl` умеет это сам,
 * а сервер может стоять в UTC, тогда как «14:00» имеется в виду местное.
 */
export function localParts(now: Date, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = Number.parseInt(get('hour'), 10) % 24;
  const minute = Number.parseInt(get('minute'), 10);

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + minute,
  };
}

/** «14:00» → 840. Некорректная строка даёт null, а не тихий ноль: полночь — валидное время. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1] ?? '', 10);
  const minutes = Number.parseInt(match[2] ?? '', 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function createCycleService(deps: CycleServiceDeps) {
  const { db } = deps;

  return {
    async schedule(guildId: string): Promise<ScheduleRow | null> {
      const [row] = await db.select().from(tournamentSchedules).where(eq(tournamentSchedules.guildId, guildId));
      return row ?? null;
    },

    async enabledSchedules(): Promise<ScheduleRow[]> {
      return db.select().from(tournamentSchedules).where(eq(tournamentSchedules.enabled, true));
    },

    async upsertSchedule(guildId: string, patch: Partial<Omit<ScheduleRow, 'guildId'>>): Promise<ScheduleRow> {
      const [row] = await db
        .insert(tournamentSchedules)
        .values({ guildId, games: patch.games ?? ['dota2', 'lol', 'valorant'], ...patch })
        .onConflictDoUpdate({
          target: tournamentSchedules.guildId,
          set: { ...patch, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error('расписание турниров не сохранилось');
      return row;
    },

    /**
     * Строка сегодняшнего дня. Уникальность `(guildId, cycleDate)` — и есть защита от
     * того, что перезапуск процесса, наложение прогонов или повторная доставка дадут два
     * голосования за один день; поэтому вставка идёт через `onConflictDoNothing`, а не
     * через «проверить и вставить», между которыми встал бы конкурентный прогон.
     */
    async claimDay(guildId: string, cycleDate: string): Promise<CycleRow | null> {
      const [inserted] = await db
        .insert(tournamentCycles)
        .values({ guildId, cycleDate, stage: 'poll' })
        .onConflictDoNothing()
        .returning();
      return inserted ?? null;
    },

    async today(guildId: string, cycleDate: string): Promise<CycleRow | null> {
      const [row] = await db
        .select()
        .from(tournamentCycles)
        .where(and(eq(tournamentCycles.guildId, guildId), eq(tournamentCycles.cycleDate, cycleDate)));
      return row ?? null;
    },

    async updateCycle(cycleId: number, patch: Partial<Omit<CycleRow, 'id'>>): Promise<void> {
      await db
        .update(tournamentCycles)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(tournamentCycles.id, cycleId));
    },

    async skipDay(cycleId: number, reason: string): Promise<void> {
      await db
        .update(tournamentCycles)
        .set({ stage: 'skipped', skipReason: reason, updatedAt: new Date() })
        .where(eq(tournamentCycles.id, cycleId));
    },

    async bumpEmptyDays(guildId: string, empty: boolean): Promise<number> {
      const current = await this.schedule(guildId);
      if (!current) return 0;
      const next = empty ? current.emptyDays + 1 : 0;
      // На пороге автомат встаёт сам: бот, который каждый день сообщает «никто не пришёл»,
      // перестаёт читаться уже на третий раз — и тогда его перестают читать и в тот день,
      // когда пришли.
      const enabled = next < EMPTY_DAYS_LIMIT;
      await db
        .update(tournamentSchedules)
        .set({ emptyDays: next, enabled, updatedAt: new Date() })
        .where(eq(tournamentSchedules.guildId, guildId));
      return next;
    },
  };
}

export type CycleService = ReturnType<typeof createCycleService>;

/** Текст, которым бот объявляет условия участия. Отдельная функция — чтобы его было видно. */
export function announcementText(input: {
  name: string;
  game: TournamentGame;
  entryMode: 'solo' | 'team';
  teamSize: number;
  maxEntrants: number;
  startsAtUnix: number;
  bracketUrl: string;
}): string {
  const gameLabel = TOURNAMENT_GAME_LABELS[input.game] ?? input.game;

  const howTo =
    input.entryMode === 'team'
      ? [
          `**Как попасть.** Капитан пишет \`/team create\` с названием — бот вывесит карточку с кнопкой «Вступить». Остальные жмут её сами, приглашать никого не надо.`,
          `**Состав:** ${input.teamSize} человек. Каждому нужна подтверждённая привязка ${gameLabel} — команда \`/link\`.`,
          `**До старта** капитан отмечает состав: \`/checkin\`. Не отметились — в сетку не попадёте.`,
        ]
      : [
          `**Как попасть.** Напиши \`/team create\` со своим ником — состав тут не нужен.`,
          `**Нужна подтверждённая привязка** ${gameLabel} — команда \`/link\`.`,
          `**До старта** отметься: \`/checkin\`.`,
        ];

  return [
    `## ${input.name}`,
    `${gameLabel} · ${input.entryMode === 'team' ? `команды по ${input.teamSize}` : 'одиночки'} · до ${input.maxEntrants} участников`,
    `Старт <t:${input.startsAtUnix}:t>, регистрация до этого времени.`,
    '',
    ...howTo,
    '',
    `Сетка и результаты: ${input.bracketUrl}`,
  ].join('\n');
}

/** Как назвать событие по числу участников: два — уже не турнир, но проводим. */
export function eventLabel(entrantCount: number): string {
  return EVENT_SIZE_LABELS[eventSize(entrantCount)];
}
