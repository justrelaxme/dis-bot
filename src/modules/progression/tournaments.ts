import type { BotEvents } from '../../core/events/events.js';
import { XP_RANK_UP, XP_TOURNAMENT_PLAY, XP_TOURNAMENT_WIN } from './rules.js';
import type { ProgressionService } from './service.js';

/**
 * Что прогрессия делает с чужими событиями: турнир стартовал, закончился, ранг вырос.
 *
 * Четыре достижения из каталога и два источника опыта были объявлены, но не выдавались
 * никогда: «Дебют», «Капитан», «Серия», «Растёт», опыт за участие и за рост ранга. Условие
 * у них было, а события, на котором его проверить, — нет. Теперь турниры и привязки
 * рассказывают, что случилось, а решает, что за это положено, только этот файл.
 *
 * Функции без Discord и без шины — только сервис: так их можно проверить подделкой, не
 * поднимая ни бота, ни базы.
 */

type Progression = Pick<ProgressionService, 'award' | 'grantAchievement' | 'countEvents'>;

/** Отказ одной награды не должен срывать остальные: у каждого участника своя строка. */
const quietly = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);

export async function onTournamentStarted(
  progression: Progression,
  payload: BotEvents['tournament.started'],
): Promise<void> {
  for (const userId of payload.participantUserIds) {
    await quietly(
      progression.award(payload.guildId, userId, XP_TOURNAMENT_PLAY, 'tournament-play', {
        tournamentId: payload.tournamentId,
      }),
    );
    await quietly(progression.grantAchievement(payload.guildId, userId, 'first-tournament'));
  }
  for (const userId of payload.captainUserIds) {
    await quietly(progression.grantAchievement(payload.guildId, userId, 'captain'));
  }
}

/** Сколько титулов нужно для «Серии». */
export const THREE_PEAT = 3;

export async function onTournamentFinished(
  progression: Progression,
  payload: BotEvents['tournament.finished'],
): Promise<void> {
  for (const userId of payload.winnerUserIds) {
    await progression.award(payload.guildId, userId, XP_TOURNAMENT_WIN, 'tournament-win', {
      tournamentId: payload.tournamentId,
    });
    await quietly(progression.grantAchievement(payload.guildId, userId, 'champion'));
    // Считаем по событиям опыта за победу: они живут дольше сезона, и третий титул остаётся
    // третьим, даже если первые два были в прошлом сезоне.
    if ((await progression.countEvents(payload.guildId, userId, 'tournament-win')) >= THREE_PEAT) {
      await quietly(progression.grantAchievement(payload.guildId, userId, 'three-peat'));
    }
  }
}

/**
 * Ранг вырос. У события нет сервера — ранг живёт в игре, а не на сервере, — поэтому награда
 * идёт на каждом сервере, где человек есть: вызывающий передаёт их список.
 */
export async function onRankChanged(
  progression: Progression,
  guildIds: readonly string[],
  payload: BotEvents['rank.changed'],
): Promise<void> {
  if (!payload.climbed) return;
  for (const guildId of guildIds) {
    await quietly(
      progression.award(guildId, payload.userId, XP_RANK_UP, 'rank-up', {
        provider: payload.provider,
        mode: payload.mode,
      }),
    );
    await quietly(progression.grantAchievement(guildId, payload.userId, 'rank-climber'));
  }
}
