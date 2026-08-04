import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { createLogger } from '../../../../src/core/logger.js';
import {
  createTournamentEventsGateway,
  explainAnnounceFailure,
} from '../../../../src/modules/tournaments/discord/events.js';
import type { TournamentRow } from '../../../../src/modules/tournaments/schema.js';

/**
 * Афиша во вкладке «События». Тестов у неё не было, и дефект оказался ровно там, где их
 * недоставало: право проверялось по кэшу участников, а кэш пуст, пока в него не положат. Право
 * могло быть выдано, а афиши не появлялось — молча, потому что наверх уходил безликий `null`.
 */

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const tournament = {
  id: 7,
  name: 'Кубок',
  game: 'dota2',
  entryMode: 'team',
  teamSize: 5,
  format: 'double-elim',
  abilities: true,
} as TournamentRow;

function guildWith(options: {
  /** Право «Управление событиями» у бота есть? */
  allowed?: boolean;
  /** `fetchMe` отказывает: так ведёт себя Discord, когда не отвечает вовсе. */
  fetchMeFails?: boolean;
  createFails?: boolean;
}) {
  // Отправленное складывается сюда, а не читается из mock.calls: без объявленного параметра
  // тип аргументов у мока пустой, и прочитать то, что ушло в Discord, тест бы не смог.
  const sent: Record<string, unknown>[] = [];
  const create = vi.fn(async (payload: Record<string, unknown>) => {
    sent.push(payload);
    if (options.createFails) throw new Error('Discord отказал');
    return { id: 'event-1' };
  });
  const fetchMe = vi.fn(async () => {
    if (options.fetchMeFails) throw new Error('участник не найден');
    return {
      permissions: {
        has: (flag: bigint) => (options.allowed ?? true) && flag === PermissionFlagsBits.ManageEvents,
      },
    };
  });

  return {
    guild: {
      id: 'guild-1',
      // Кэш намеренно пуст: именно в этом состоянии проверка и отвечала «права нет».
      members: { me: null, fetchMe },
      scheduledEvents: { create },
    } as never,
    create,
    fetchMe,
    sent,
  };
}

const start = new Date('2026-08-10T18:00:00.000Z');

describe('афиша турнира', () => {
  /**
   * Главное свойство: право спрашивается у Discord, а не у кэша. `guild.members.me` здесь
   * пуст — то есть ровно то состояние, в котором афиша и не появлялась.
   */
  it('право спрашивается у Discord, даже когда кэш участников пуст', async () => {
    const { guild, fetchMe, create } = guildWith({ allowed: true });
    const events = createTournamentEventsGateway(logger);

    const result = await events.announce(guild, tournament, start, 'https://bot.test/t/7');

    expect(fetchMe).toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, eventId: 'event-1' });
  });

  it('без права афиши нет, и причина названа', async () => {
    const { guild, create } = guildWith({ allowed: false });
    const events = createTournamentEventsGateway(logger);

    const result = await events.announce(guild, tournament, start, 'https://bot.test/t/7');

    expect(result).toEqual({ ok: false, reason: 'no-permission' });
    expect(create).not.toHaveBeenCalled();
  });

  /** Не удалось спросить — лучше не обещать афишу, чем обещать и не сделать. */
  it('недоступный Discord считается отсутствием права, а не разрешением', async () => {
    const { guild, create } = guildWith({ fetchMeFails: true });
    const events = createTournamentEventsGateway(logger);

    const result = await events.announce(guild, tournament, start, 'https://bot.test/t/7');

    expect(result).toEqual({ ok: false, reason: 'no-permission' });
    expect(create).not.toHaveBeenCalled();
  });

  it('отказ при создании — своя причина, а не «нет права»', async () => {
    const { guild } = guildWith({ allowed: true, createFails: true });
    const events = createTournamentEventsGateway(logger);

    const result = await events.announce(guild, tournament, start, 'https://bot.test/t/7');

    expect(result).toEqual({ ok: false, reason: 'failed' });
  });

  /**
   * Discord отклоняет событие в прошлом. Регистрация же может открыться уже после назначенного
   * часа старта — и тогда афиша не создавалась бы вообще ни разу, без объяснений.
   */
  it('начало в прошлом сдвигается вперёд, а не отправляется как есть', async () => {
    const { guild, sent } = guildWith({ allowed: true });
    const events = createTournamentEventsGateway(logger);

    await events.announce(guild, tournament, new Date('2020-01-01T00:00:00.000Z'), 'https://bot.test/t/7');

    const payload = sent[0] as unknown as { scheduledStartTime: Date };
    expect(payload.scheduledStartTime.getTime()).toBeGreaterThan(Date.now());
  });

  it('конец события есть всегда: у внешнего Discord его требует', async () => {
    const { guild, sent } = guildWith({ allowed: true });
    const events = createTournamentEventsGateway(logger);

    await events.announce(guild, tournament, start, 'https://bot.test/t/7');

    const payload = sent[0] as unknown as {
      scheduledStartTime: Date;
      scheduledEndTime: Date;
    };
    expect(payload.scheduledEndTime.getTime()).toBeGreaterThan(payload.scheduledStartTime.getTime());
  });

  it('в афише есть ссылка на сетку: за ней в неё и приходят', async () => {
    const { guild, sent } = guildWith({ allowed: true });
    const events = createTournamentEventsGateway(logger);

    await events.announce(guild, tournament, start, 'https://bot.test/t/7');

    const payload = sent[0] as unknown as {
      description: string;
      entityMetadata: { location: string };
    };
    expect(payload.description).toContain('https://bot.test/t/7');
    expect(payload.entityMetadata.location).toBe('https://bot.test/t/7');
  });
});

describe('что сказать организатору', () => {
  /** Он и есть тот, кто может выдать право, — значит должен узнать, какое именно. */
  it('про отсутствие права сказано, какое право выдать', () => {
    expect(explainAnnounceFailure('no-permission')).toContain('Управление событиями');
  });

  it('про отказ Discord сказано, что турнир это не затрагивает', () => {
    const text = explainAnnounceFailure('failed');

    expect(text).not.toContain('Управление событиями');
    expect(text).toContain('Турнир');
  });
});
