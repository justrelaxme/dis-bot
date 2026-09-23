import { describe, expect, it } from 'vitest';
import { renderPlayer, type PlayerView } from '../../../src/modules/web/render.js';

const view = (over: Partial<PlayerView> = {}): PlayerView => ({
  name: 'Первый',
  record: { tournaments: 0, titles: 0, matchesPlayed: 0, matchesWon: 0, recent: [] },
  season: null,
  achievements: [],
  ranks: null,
  showAccounts: false,
  ...over,
});

const rank = {
  game: 'Dota 2',
  displayName: 'НикВИгре',
  mode: 'ranked',
  scale: 'dota-mmr' as const,
  tier: 'Legend',
  division: '3',
  points: null,
  claimed: false,
  score: 0,
};

describe('карточка игрока', () => {
  it('имя экранируется: его пишет сам игрок', () => {
    expect(renderPlayer(view({ name: '<script>x</script>' }))).not.toContain('<script>x');
  });

  it('без турниров — пустое состояние, а не пустая таблица', () => {
    const html = renderPlayer(view());

    expect(html).toContain('карточка заполнится после первого');
    expect(html).not.toContain('<table>');
  });

  it('матчи — победы и поражения, сезон — только если игрок в таблице', () => {
    const html = renderPlayer(
      view({ record: { tournaments: 3, titles: 1, matchesPlayed: 7, matchesWon: 5, recent: [] } }),
    );

    expect(html).toContain('5–2');
    expect(html).toContain('1</span>\n<span class="pn">титул');
    expect(html).not.toContain('сезон «');
  });

  it('ник аккаунта — только по отдельному согласию', () => {
    expect(renderPlayer(view({ ranks: [rank] }))).not.toContain('НикВИгре');
    expect(renderPlayer(view({ ranks: [rank], showAccounts: true }))).toContain('НикВИгре');
    expect(renderPlayer(view({ ranks: [rank] }))).toContain('Legend 3');
  });

  it('заявленный руками ранг помечен', () => {
    expect(renderPlayer(view({ ranks: [{ ...rank, claimed: true }] }))).toContain('заявлено');
  });
});
