import { describe, expect, it } from 'vitest';
import type { EntrantRow, MatchRow, TournamentRow } from '../../../src/modules/tournaments/schema.js';
import { page, renderBracket } from '../../../src/modules/web/render.js';

/**
 * Страница сетки. Номер матча над карточкой — не украшение: его вписывают в `/match resolve`,
 * а раньше на странице его не было вовсе. И страница идущего турнира должна обновляться сама.
 */

const tournament = {
  id: 7,
  name: 'Кубок',
  game: 'dota2',
  state: 'running',
  entryMode: 'solo',
  teamSize: 1,
  format: 'single-elim',
} as unknown as TournamentRow;

const entrants = [
  { id: 1, displayName: 'Альфа', seed: 1, withdrawnAt: null, checkedInAt: new Date() },
  { id: 2, displayName: 'Браво', seed: 2, withdrawnAt: null, checkedInAt: new Date() },
] as unknown as EntrantRow[];

const match = (over: Partial<MatchRow>): MatchRow =>
  ({
    id: 12,
    tournamentId: 7,
    bracket: 'upper',
    round: 1,
    slot: 0,
    entrantAId: 1,
    entrantBId: 2,
    winnerEntrantId: null,
    state: 'ready',
    scoreA: null,
    scoreB: null,
    ...over,
  }) as MatchRow;

describe('сетка', () => {
  it('над карточкой — номер матча', () => {
    const html = renderBracket({ tournament, entrants, matches: [match({})] });

    expect(html).toContain('№12');
  });

  it('у матча с драфтом — ссылка на полотно', () => {
    const html = renderBracket({ tournament, entrants, matches: [match({})], drafts: new Set([12]) });

    expect(html).toContain('href="/draft/12"');
  });

  it('без драфта ссылки нет', () => {
    const html = renderBracket({ tournament, entrants, matches: [match({})], drafts: new Set() });

    expect(html).not.toContain('/draft/12');
  });

  /** Матч, которого не будет, номера не получает: искать его незачем. */
  it('у несостоявшегося матча номера нет', () => {
    const html = renderBracket({ tournament, entrants, matches: [match({ state: 'void', entrantAId: null, entrantBId: null })] });

    expect(html).not.toContain('№12');
  });
});

describe('живая страница', () => {
  it('с турниром для слушания — подписывается на поток', () => {
    const html = page('Кубок', '<p>сетка</p>', { live: 7 });

    expect(html).toContain('data-live="7"');
    expect(html).toContain("new EventSource('/api/live/t/' + id)");
  });

  it('без него — обычная страница без скрипта', () => {
    const html = page('Кубок', '<p>сетка</p>');

    expect(html).not.toContain('data-live');
    expect(html).not.toContain('EventSource');
  });
});
