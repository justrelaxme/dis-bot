import { describe, expect, it } from 'vitest';
import { buildRecap, type WeekData } from '../../../src/modules/tournaments/recap.js';
import { recapDue } from '../../../src/modules/tournaments/discord/weekly.js';

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
