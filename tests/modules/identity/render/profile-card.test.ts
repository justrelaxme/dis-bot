import { describe, expect, it } from 'vitest';
import type { GameAccountRow } from '../../../../src/modules/identity/services/linking.js';
import type { RankInfo } from '../../../../src/modules/identity/providers/provider.js';
import { buildProfileCard, formatDelta, formatRank } from '../../../../src/modules/identity/render/profile-card.js';

function account(overrides: Partial<GameAccountRow> = {}): GameAccountRow {
  return {
    id: 1,
    userId: '222222222222222222',
    provider: 'riot-lol',
    externalId: 'PUUID-1',
    displayName: 'Игрок#EUW',
    region: 'euw1',
    verifiedAt: new Date('2026-07-01T00:00:00Z'),
    verificationMethod: 'riot-third-party-code',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-27T00:00:00Z'),
    ...overrides,
  } as GameAccountRow;
}

function rank(tier: string, division: string | null, points: number | null, source: 'api' | 'manual' = 'api'): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division, points, source, raw: {} };
}

function dotaRank(points: number | null): RankInfo {
  return { mode: 'dota-mmr', scale: 'dota-mmr', tier: 'IMMORTAL', division: null, points, source: 'api', raw: {} };
}

describe('formatRank', () => {
  it('собирает тир, дивизион и очки', () => {
    expect(formatRank(rank('PLATINUM', 'II', 47))).toBe('Platinum II · 47 LP');
  });

  it('опускает дивизион у тиров без него', () => {
    expect(formatRank(rank('CHALLENGER', null, 1204))).toBe('Challenger · 1204 LP');
  });

  it('опускает очки, когда их нет', () => {
    expect(formatRank(rank('LEGEND', '3', null))).toBe('Legend 3');
  });

  it('помечает ручной ранг как заявленный игроком', () => {
    expect(formatRank(rank('IMMORTAL', 'II', null, 'manual'))).toContain('со слов игрока');
  });

  // Находка 2: normalizeDotaRank кладёт место в лидерборде (меньше — лучше) в то же
  // поле points, что и LP у остальных шкал, но это другое измерение — rankScore это
  // уже учитывает (ranks/compare.ts), а formatRank до этой правки — нет.
  it('показывает место в лидерборде Dota, а не LP', () => {
    expect(formatRank(dotaRank(412))).toBe('Immortal · 412-е место в лидерборде');
  });

  it('не показывает LP и не показывает место, когда его нет', () => {
    expect(formatRank(dotaRank(null))).toBe('Immortal');
  });
});

describe('formatDelta', () => {
  it('показывает рост со стрелкой вверх', () => {
    expect(formatDelta(rank('GOLD', 'I', 0), rank('PLATINUM', 'IV', 10))).toContain('↑');
  });

  it('показывает падение со стрелкой вниз', () => {
    expect(formatDelta(rank('PLATINUM', 'IV', 10), rank('GOLD', 'I', 0))).toContain('↓');
  });

  it('сообщает об отсутствии изменений', () => {
    expect(formatDelta(rank('GOLD', 'II', 10), rank('GOLD', 'II', 40))).toContain('без изменений');
  });

  it('сообщает, что сравнивать не с чем', () => {
    expect(formatDelta(null, rank('GOLD', 'II', 10))).toContain('новый');
  });
});

describe('buildProfileCard', () => {
  it('строит контейнер с именем пользователя', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [{ account: account(), ranks: [rank('GOLD', 'II', 20)], previous: new Map() }],
    });

    expect(JSON.stringify(card.toJSON())).toContain('Саня');
  });

  it('показывает ранг привязанного аккаунта', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [{ account: account(), ranks: [rank('GOLD', 'II', 20)], previous: new Map() }],
    });

    expect(JSON.stringify(card.toJSON())).toContain('Gold II');
  });

  it('сообщает, когда привязок нет', () => {
    const card = buildProfileCard({ displayName: 'Саня', entries: [] });
    expect(JSON.stringify(card.toJSON())).toContain('link');
  });

  it('помечает неподтверждённую привязку', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [
        {
          account: account({ provider: 'riot-valorant', verifiedAt: null, verificationMethod: 'manual' }),
          ranks: [rank('IMMORTAL', 'II', null, 'manual')],
          previous: new Map(),
        },
      ],
    });

    expect(JSON.stringify(card.toJSON())).toContain('не подтверждён');
  });

  it('показывает отметку времени, когда данные из устаревшего кэша', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [
        {
          account: account(),
          ranks: [rank('GOLD', 'II', 20)],
          previous: new Map(),
          staleSince: new Date('2026-07-27T14:32:00Z'),
        },
      ],
    });

    expect(JSON.stringify(card.toJSON())).toContain('14:32');
  });

  // Находка 1: staleSince обязана появляться только когда данные реально устарели.
  // Без записи ниже пробел в покрытии не заметил бы регресс вида «отметка всегда
  // показывается» или «показывается, даже когда staleSince не задан».
  it('не показывает отметку устаревания, когда данные свежие', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [{ account: account(), ranks: [rank('GOLD', 'II', 20)], previous: new Map() }],
    });

    expect(JSON.stringify(card.toJSON())).not.toContain('сервис игры не ответил');
  });

  it('не показывает отметку устаревания у ручного ранга', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [
        {
          account: account({ provider: 'riot-valorant', verifiedAt: null, verificationMethod: 'manual' }),
          ranks: [rank('IMMORTAL', 'II', null, 'manual')],
          previous: new Map(),
          // profile.ts никогда не заполняет staleSince для ручного ранга (нет
          // rankFreshness у provider без fetchRank) — здесь фиксируется то же самое
          // поведение на уровне карточки: раз staleSince не задан, отметки не будет.
        },
      ],
    });

    expect(JSON.stringify(card.toJSON())).not.toContain('сервис игры не ответил');
  });

  it('не превышает предел контейнера в 10 компонентов', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      account: account({ id: index + 1, externalId: `PUUID-${index}` }),
      ranks: [rank('GOLD', 'II', 20)],
      previous: new Map<string, RankInfo | null>(),
    }));

    const json = buildProfileCard({ displayName: 'Саня', entries });
    const components = (json.toJSON() as { components: unknown[] }).components;

    expect(components.length).toBeLessThanOrEqual(10);
  });
});
