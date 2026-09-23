import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/logger.js';
import { buildRecap, type WeekData } from '../../../src/modules/tournaments/recap.js';
import { recapDue, runWeeklyRecap, splitMessage } from '../../../src/modules/tournaments/discord/weekly.js';
import type { RecapsService } from '../../../src/modules/tournaments/services/recaps.js';

/**
 * Итог недели. Итог, который не читают, хуже его отсутствия: пустые разделы не показываются,
 * а неделя без турниров не даёт итога совсем.
 */

const empty: WeekData = { tournaments: [], streaks: [], drafts: [], predictor: null, upset: null, season: null };
const week = (over: Partial<WeekData> = {}): WeekData => ({
  ...empty,
  tournaments: [{ name: 'Кубок', game: 'dota2', champion: 'Медведи', entrants: 8 }],
  ...over,
});

describe('итог недели', () => {
  it('неделя без турниров — итога нет', () => {
    expect(buildRecap(empty)).toBeNull();
  });

  it('чемпионы — всегда', () => {
    expect(buildRecap(week())).toContain('🏆 Кубок (Dota 2, 8 уч.) — **Медведи**');
  });

  it('пустые разделы не показываются', () => {
    const text = buildRecap(week()) ?? '';
    expect(text).not.toContain('Апсет');
    expect(text).not.toContain('Драфт');
    expect(text).not.toContain('Прогнозист');
    expect(text).not.toContain('Сезон');
  });

  it('серия, апсет, драфт, прогнозист и сезон — когда есть', () => {
    const text =
      buildRecap(
        week({
          streaks: [{ userId: 'u1', titles: 2 }],
          upset: { winner: 'Рыси', loser: 'Медведи', winnerSeed: 7, loserSeed: 2, tournament: 'Кубок' },
          drafts: [{ game: 'dota2', pick: { label: 'Pudge', count: 4 }, ban: { label: 'Invoker', count: 3 } }],
          predictor: { userId: 'u2', coins: 45, correct: 5, total: 6 },
          season: { name: 'Осень', leaders: [{ userId: 'u1', points: 30 }] },
        }),
      ) ?? '';

    expect(text).toContain('<@u1> — 2 титула за неделю');
    expect(text).toContain('Рыси (сид 7) обыграл Медведи (сид 2)');
    expect(text).toContain('чаще всех брали **Pudge** (4), банили — **Invoker** (3)');
    expect(text).toContain('<@u2>: угадал 5 из 6, +45 монет');
    expect(text).toContain('Сезон «Осень»');
  });
});

describe('когда публиковать', () => {
  it('понедельник после полудня по часовому поясу сервера', () => {
    // 2026-09-28 — понедельник. 11:00 UTC = 13:00 в Берлине летом.
    expect(recapDue(new Date('2026-09-28T11:00:00Z'), 'Europe/Berlin')).toBe(true);
    expect(recapDue(new Date('2026-09-28T09:00:00Z'), 'Europe/Berlin')).toBe(false);
    expect(recapDue(new Date('2026-09-29T11:00:00Z'), 'Europe/Berlin')).toBe(false);
  });
});

describe('длинный итог', () => {
  it('режется по строкам, ни одна часть не длиннее предела', () => {
    const text = Array.from({ length: 40 }, (_, index) => `строка ${index} ${'x'.repeat(60)}`).join('\n');
    const parts = splitMessage(text, 500);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 500)).toBe(true);
    expect(parts.join('\n')).toBe(text);
  });

  it('строка длиннее предела режется по пределу', () => {
    const parts = splitMessage('y'.repeat(1_200), 500);

    expect(parts.map((part) => part.length)).toEqual([500, 500, 200]);
  });

  it('короткий итог — одно сообщение', () => {
    expect(splitMessage('коротко')).toEqual(['коротко']);
  });
});

/** Понедельник, 13:00 в Берлине. */
const MONDAY = new Date('2026-09-28T11:00:00Z');
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function recaps(over: Partial<RecapsService>) {
  return {
    guildsWithFinished: vi.fn(async () => ['g1']),
    claim: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    posted: vi.fn(async () => undefined),
    channelOf: vi.fn(async () => 'c1'),
    gather: vi.fn(async () => ({ ...empty, tournaments: [{ name: 'Кубок', game: 'dota2' as const, champion: 'Медведи', entrants: 8 }] })),
    ...over,
  } as unknown as RecapsService & Record<'claim' | 'release' | 'posted', ReturnType<typeof vi.fn>>;
}

function clientWith(send: (options: { content: string }) => Promise<{ id: string }>): Client {
  return { channels: { fetch: async () => ({ isSendable: () => true, send }) } } as unknown as Client;
}

describe('публикация итога', () => {
  const cycles = { schedule: async () => null };

  it('сбой при сборке итога отпускает неделю — через час будет повтор', async () => {
    const service = recaps({ gather: vi.fn(async () => Promise.reject(new Error('база недоступна'))) });

    await runWeeklyRecap({ recaps: service, cycles }, clientWith(async () => ({ id: 'm1' })), quiet, MONDAY);

    expect(service.release).toHaveBeenCalledWith('g1', '2026-09-28');
    expect(service.posted).not.toHaveBeenCalled();
  });

  it('вышла часть итога — неделя остаётся за вышедшим, без повтора и дубля', async () => {
    const long = Array.from({ length: 60 }, (_, index) => ({ name: `Турнир номер ${index} ${'и'.repeat(20)}`, game: 'dota2' as const, champion: 'Медведи', entrants: 8 }));
    const service = recaps({ gather: vi.fn(async () => ({ ...empty, tournaments: long })) });
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls > 1) throw new Error('Discord недоступен');
      return { id: 'm1' };
    };

    await runWeeklyRecap({ recaps: service, cycles }, clientWith(send), quiet, MONDAY);

    expect(service.posted).toHaveBeenCalledWith('g1', '2026-09-28', 'm1');
    expect(service.release).not.toHaveBeenCalled();
  });

  it('итог вышел целиком — неделя отмечена первым сообщением', async () => {
    const service = recaps({});

    await runWeeklyRecap({ recaps: service, cycles }, clientWith(async () => ({ id: 'm7' })), quiet, MONDAY);

    expect(service.posted).toHaveBeenCalledWith('g1', '2026-09-28', 'm7');
  });
});
