import type { Client } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { buildRecap } from '../recap.js';
import { localParts, type CycleService } from '../services/cycle.js';
import type { RecapsService } from '../services/recaps.js';

/**
 * Итог недели сам собой: в понедельник, в полдень по часовому поясу сервера, бот публикует в
 * канал объявлений, что было за неделю. Турнир прошёл — и через день о нём никто не помнит;
 * итог даёт ему второй раз попасться на глаза, уже с сюжетом: серии, апсет, лидеры сезона.
 */

/** Во сколько публиковать: к полудню понедельника неделя точно закончилась у всех. */
export const RECAP_AT_MINUTES = 12 * 60;

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

/** Предел сообщения Discord — 2000 символов; запас на случай, если Discord посчитает иначе. */
const MESSAGE_LIMIT = 1_900;

/**
 * Разбить итог на сообщения по границам строк. Неделя с семью турнирами и длинными названиями
 * не влезает в одно сообщение — и без разбивки итог не вышел бы вовсе: Discord отказывал бы
 * каждый час весь понедельник. Строка длиннее предела режется по пределу.
 */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    for (let piece = line; ; piece = piece.slice(limit)) {
      const chunk = piece.slice(0, limit);
      const joined = current ? `${current}\n${chunk}` : chunk;
      if (joined.length > limit) {
        parts.push(current);
        current = chunk;
      } else {
        current = joined;
      }
      if (piece.length <= limit) break;
    }
  }
  if (current) parts.push(current);
  return parts;
}
const DEFAULT_TIMEZONE = 'Europe/Berlin';

export function weekdayIn(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
}

/** Пора ли публиковать итог: понедельник, полдень прошёл. */
export function recapDue(now: Date, timezone: string): boolean {
  return weekdayIn(now, timezone) === 'Mon' && localParts(now, timezone).minutes >= RECAP_AT_MINUTES;
}

export async function runWeeklyRecap(
  deps: { recaps: RecapsService; cycles: Pick<CycleService, 'schedule'> },
  client: Client,
  logger: Logger,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - WEEK_MS);
  for (const guildId of await deps.recaps.guildsWithFinished(since, now)) {
    try {
      const schedule = await deps.cycles.schedule(guildId);
      const timezone = schedule?.timezone ?? DEFAULT_TIMEZONE;
      if (!recapDue(now, timezone)) continue;

      const weekOf = localParts(now, timezone).date;
      if (!(await deps.recaps.claim(guildId, weekOf))) continue;

      // Неделя занята. Всё, что дальше может упасть, обязано её отпустить: иначе сбой базы в
      // понедельник днём оставил бы неделю занятой без итога, и повтора не было бы.
      let firstId: string | null = null;
      try {
        const text = buildRecap(await deps.recaps.gather(guildId, since, now));
        // Неделя без турниров: итога нет, но неделя остаётся занятой — пустоту не публикуют.
        if (!text) continue;

        const channelId = schedule?.announceChannelId ?? (await deps.recaps.channelOf(guildId));
        const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
        if (!channel?.isSendable()) {
          await deps.recaps.release(guildId, weekOf);
          logger.warn({ guildId }, 'итог недели некуда отправить: канал объявлений не найден');
          continue;
        }
        // Упоминания в итоге — чтобы имена были кликабельными, а не чтобы звать: без пинга.
        for (const part of splitMessage(text)) {
          const sent = await channel.send({ content: part, allowedMentions: { parse: [] } });
          firstId ??= sent.id;
        }
        if (firstId) await deps.recaps.posted(guildId, weekOf, firstId);
      } catch (error) {
        if (firstId) {
          // Часть итога уже в канале: повтор продублировал бы её. Неделя остаётся за вышедшим.
          await deps.recaps.posted(guildId, weekOf, firstId).catch(() => undefined);
          logger.warn({ err: error, guildId }, 'итог недели вышел не целиком');
        } else {
          await deps.recaps.release(guildId, weekOf).catch(() => undefined);
          logger.warn({ err: error, guildId }, 'итог недели не вышел — попробую через час');
        }
      }
    } catch (error) {
      logger.error({ err: error, guildId }, 'итог недели не собрался');
    }
  }
}
