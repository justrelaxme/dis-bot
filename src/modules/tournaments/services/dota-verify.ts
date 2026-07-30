import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../../core/db/client.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';
import { gameAccounts } from '../../identity/schema.js';
import { steamId64ToAccountId } from '../../identity/providers/steam.js';
import { tournamentEntrantMembers } from '../schema.js';

const OPENDOTA_API = 'https://api.opendota.com/api';

/** Те же лимиты, что у синхронизации рангов: у OpenDota одна квота на всё. */
const OPENDOTA_LIMITS: Limit[] = [
  { tokens: 50, windowMs: 60_000 },
  { tokens: 1_800, windowMs: 24 * 60 * 60 * 1_000 },
];

/**
 * Игроки первой команды сидят в слотах 0–4, второй — в 128–132. Это кодировка самой Dota,
 * а не изобретение OpenDota.
 */
const DIRE_SLOT_BASE = 128;

/**
 * Сколько игроков надо узнать, чтобы поверить. Хотя бы по одному с каждой стороны — иначе
 * непонятно даже то, играли ли эти две команды между собой: одна опознанная фамилия на
 * радианте одинаково согласуется и с «они играли друг с другом», и с «он играл с кем-то
 * посторонним».
 */
const MIN_PER_SIDE = 1;

const matchSchema = z.object({
  match_id: z.number().optional(),
  /** null у матча, который OpenDota ещё не разобрала. */
  radiant_win: z.boolean().nullable().default(null),
  start_time: z.number().nullable().default(null),
  players: z
    .array(
      z.object({
        /** null — профиль скрыт: игрок не включил «показывать данные публичных матчей». */
        account_id: z.number().nullable().default(null),
        player_slot: z.number(),
      }),
    )
    .default([]),
});

/**
 * Что показали данные. Проверяющий говорит только «кто победил по данным» — совпадает это
 * с заявкой или противоречит ей, решает вызывающий: сравнение с заявленным победителем
 * это его дело, а не дело того, кто читает OpenDota.
 */
export type MatchVerdict =
  | { kind: 'decided'; winnerEntrantId: number; identifiedA: number; identifiedB: number }
  /** Проверить не удалось. Это норма, а не сбой: дальше обычный путь с подтверждением соперника. */
  | { kind: 'unknown'; reason: string };

export interface DotaVerifyDeps {
  db: Database;
  client: FetchClient;
  rateLimiter: RateLimiter;
}

/**
 * Проверка результата матча Dota по публичным данным OpenDota.
 *
 * Зачем: самозаявка с подтверждением соперника работает, пока никто не врёт, а спор
 * упирается в организатора. Здесь бот смотрит сам и в удачном случае закрывает матч
 * мгновенно — соперника ждать не надо.
 *
 * **Проверка необязательна и часто невозможна, и это заложено в конструкцию.** OpenDota
 * видит `account_id` игрока только если тот включил в Dota «показывать данные публичных
 * матчей», а по умолчанию это выключено. Поэтому любой отрицательный исход, кроме прямого
 * противоречия, — это `unknown`, и дальше работает обычный путь. Проверка добавляет
 * скорость и ловит ложные заявки, но ни на что не является обязательным условием.
 */
export function createDotaVerifier(deps: DotaVerifyDeps) {
  /** account_id всех подтверждённых Steam-привязок состава. */
  async function accountIdsOf(entrantId: number): Promise<Set<number>> {
    const rows = await deps.db
      .select({ externalId: gameAccounts.externalId })
      .from(tournamentEntrantMembers)
      .innerJoin(gameAccounts, eq(gameAccounts.userId, tournamentEntrantMembers.userId))
      .where(
        and(
          eq(tournamentEntrantMembers.entrantId, entrantId),
          eq(gameAccounts.provider, 'steam'),
          isNotNull(gameAccounts.verifiedAt),
        ),
      );

    const ids = new Set<number>();
    for (const row of rows) {
      const accountId = Number.parseInt(steamId64ToAccountId(row.externalId), 10);
      if (Number.isSafeInteger(accountId) && accountId > 0) ids.add(accountId);
    }
    return ids;
  }

  return {
    async verify(input: {
      dotaMatchId: string;
      entrantAId: number;
      entrantBId: number;
      /** Матч, сыгранный до начала турнира, доказательством не является. */
      notBefore: Date | null;
    }): Promise<MatchVerdict> {
      const matchId = input.dotaMatchId.trim();
      if (!/^\d{6,12}$/.test(matchId)) {
        return { kind: 'unknown', reason: 'ID матча выглядит не как ID матча Dota — это число из 6–12 цифр.' };
      }

      const [idsA, idsB] = await Promise.all([
        accountIdsOf(input.entrantAId),
        accountIdsOf(input.entrantBId),
      ]);
      if (idsA.size === 0 || idsB.size === 0) {
        return {
          kind: 'unknown',
          reason: 'Не у всех команд есть подтверждённые привязки Steam — узнать игроков в матче не по чему.',
        };
      }

      await deps.rateLimiter.acquire('opendota', OPENDOTA_LIMITS);

      let match: z.infer<typeof matchSchema>;
      try {
        match = await deps.client.json<z.infer<typeof matchSchema>>(`${OPENDOTA_API}/matches/${matchId}`, {
          schema: matchSchema,
        });
      } catch {
        // Матч не найден, OpenDota недоступна, цепь разомкнута — всё это не повод не
        // принять результат обычным путём.
        return { kind: 'unknown', reason: 'OpenDota не ответила про этот матч. Результат примем обычным путём.' };
      }

      if (match.radiant_win === null) {
        return { kind: 'unknown', reason: 'OpenDota ещё не разобрала этот матч. Попробуйте через несколько минут.' };
      }

      if (input.notBefore && match.start_time !== null) {
        const started = new Date(match.start_time * 1_000);
        if (started < input.notBefore) {
          return {
            kind: 'unknown',
            reason: 'Этот матч сыгран до начала турнира — как доказательство он не годится.',
          };
        }
      }

      let radiantA = 0;
      let direA = 0;
      let radiantB = 0;
      let direB = 0;
      for (const player of match.players) {
        if (player.account_id === null) continue;
        const dire = player.player_slot >= DIRE_SLOT_BASE;
        if (idsA.has(player.account_id)) {
          if (dire) direA += 1;
          else radiantA += 1;
        } else if (idsB.has(player.account_id)) {
          if (dire) direB += 1;
          else radiantB += 1;
        }
      }

      const identifiedA = radiantA + direA;
      const identifiedB = radiantB + direB;
      if (identifiedA < MIN_PER_SIDE || identifiedB < MIN_PER_SIDE) {
        return {
          kind: 'unknown',
          reason:
            'В этом матче не удалось узнать игроков обеих команд. Обычно так бывает, когда в Dota выключено «показывать данные публичных матчей».',
        };
      }

      // Сторона команды — та, где её опознали больше. Разделившаяся пополам команда
      // означает, что это был не тот матч (или составы играли вперемешку).
      const sideA = radiantA === direA ? null : radiantA > direA ? 'radiant' : 'dire';
      const sideB = radiantB === direB ? null : radiantB > direB ? 'radiant' : 'dire';
      if (sideA === null || sideB === null || sideA === sideB) {
        return {
          kind: 'unknown',
          reason: 'В этом матче игроки команд оказались не по разные стороны — похоже, это не тот матч.',
        };
      }

      const winnerSide = match.radiant_win ? 'radiant' : 'dire';
      const winnerEntrantId = sideA === winnerSide ? input.entrantAId : input.entrantBId;
      return { kind: 'decided', winnerEntrantId, identifiedA, identifiedB };
    },
  };
}

export type DotaVerifier = ReturnType<typeof createDotaVerifier>;
