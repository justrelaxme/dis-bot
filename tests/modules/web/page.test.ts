import { describe, expect, it } from 'vitest';
import type { DraftOption } from '../../../src/modules/tournaments/draft/pools.js';
import { GAME_IDENTITY } from '../../../src/modules/web/art.js';
import { draftShell } from '../../../src/modules/web/draft-page.js';
import { page } from '../../../src/modules/web/render.js';

/**
 * Оболочка страницы и полотно драфта. Проверяется не вид — его тест не увидит, — а то, от
 * чего вид зависит: акцент дисциплины доехал до разметки, украшение не попало в дерево
 * доступности, чужой текст экранирован, а плитки заведены на каждый вариант пула.
 */

describe('оболочка страницы', () => {
  it('акцент и подпись берутся у дисциплины', () => {
    const html = page('Кубок', '<p>тело</p>', { game: 'valorant' });

    expect(html).toContain(`--accent:${GAME_IDENTITY.valorant.accent}`);
    expect(html).toContain(GAME_IDENTITY.valorant.credit);
  });

  /**
   * Акцент дисциплины подменяется на теге `body`, а в `:root` стоит латунь сервера. Поэтому
   * проверяется именно `body`: искать `--accent` по всей странице бессмысленно — значение по
   * умолчанию есть в таблице стилей всегда.
   */
  it('без дисциплины акцент не подменяется, а полоса смешанная', () => {
    const html = page('Турниры', '<p>тело</p>');

    expect(/<body[^>]*>/.exec(html)?.[0]).toBe('<body>');
    // Смешанная полоса: в ней есть и Valve, и Riot.
    expect(html).toContain('steamstatic.com');
    expect(html).toContain('valorant-api.com');
  });

  /**
   * Полоса арта — украшение. В дереве доступности ей делать нечего: человеку со скринридером
   * она прочиталась бы шестью пустыми картинками перед каждым заголовком.
   */
  it('полоса арта скрыта от скринридера', () => {
    const html = page('Кубок', '', { game: 'dota2' });
    const band = /<div class="band"([^>]*)>/.exec(html);

    expect(band?.[1]).toContain('aria-hidden="true"');
  });

  it('заголовок экранируется', () => {
    const html = page('<script>alert(1)</script>', '');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('открытая страница отмечена в навигации', () => {
    const html = page('Правила', '', { current: '/rules' });

    expect(html).toContain('<a href="/rules" aria-current="page">Правила</a>');
    expect(html).toContain('<a href="/hall">Зал славы</a>');
  });

  it('стиль страницы попадает в head, а не в тело', () => {
    const html = page('Правила', '<p>тело</p>', { head: '<style>.x{color:red}</style>' });

    expect(html.indexOf('.x{color:red}')).toBeLessThan(html.indexOf('<body'));
  });
});

describe('полотно драфта', () => {
  const maps: DraftOption[] = ['ascent', 'bind'].map((id) => ({
    id,
    label: id,
    group: 'maps',
    imageUrl: `https://media.valorant-api.com/maps/${id}/listviewicon.png`,
    iconUrl: `https://media.valorant-api.com/maps/${id}/displayicon.png`,
  }));
  const agents: DraftOption[] = Array.from({ length: 29 }, (_, index) => ({
    id: `agent-${index}`,
    label: `Агент ${index}`,
    group: 'agents',
    imageUrl: `https://media.valorant-api.com/agents/${index}/killfeedportrait.png`,
  }));

  const shell = (pool: DraftOption[], phases: { group: 'maps' | 'agents' | 'heroes'; total: number }[]) =>
    draftShell({
      matchId: 7,
      tournamentName: 'Кубок',
      teams: { a: 'Пантеры', b: 'Кобры' },
      you: 'a',
      pool,
      phases: phases.map((phase) => ({ ...phase, done: 0, resultIds: [] })),
    });

  it('на каждую фазу своя секция, по порядку', () => {
    const html = shell([...maps, ...agents], [
      { group: 'maps', total: 2 },
      { group: 'agents', total: 14 },
    ]);
    const order = [...html.matchAll(/<section class="phase" data-group="(\w+)"/g)].map((m) => m[1]);

    expect(order).toEqual(['maps', 'agents']);
  });

  it('плитка заводится на каждый вариант своего набора', () => {
    const html = shell([...maps, ...agents], [
      { group: 'maps', total: 2 },
      { group: 'agents', total: 14 },
    ]);

    expect((html.match(/class="tile free"/g) ?? [])).toHaveLength(maps.length + agents.length);
    expect(html).toContain('data-id="ascent"');
    expect(html).toContain('data-id="agent-28"');
  });

  /**
   * Схема карты открывается по наведению только у карт: у агента и героя мелкая картинка —
   * это та же картинка помельче, и открывать её было бы бессмысленно.
   */
  it('схема по наведению есть у карт и нет у агентов', () => {
    const html = shell([...maps, ...agents], [
      { group: 'maps', total: 2 },
      { group: 'agents', total: 14 },
    ]);

    expect((html.match(/class="alt"/g) ?? [])).toHaveLength(maps.length);
  });

  it('поиск появляется только там, где вариантов много', () => {
    const html = shell([...maps, ...agents], [
      { group: 'maps', total: 2 },
      { group: 'agents', total: 14 },
    ]);

    expect(html).toContain('data-filter="agents"');
    expect(html).not.toContain('data-filter="maps"');
  });

  /**
   * Начальное состояние встраивается в страницу. Незакрытый `<` в данных закрыл бы тег
   * скрипта и превратил бы название команды в разметку — то есть в готовую дыру.
   */
  it('встроенное состояние не может закрыть тег скрипта', () => {
    const html = draftShell({
      matchId: 1,
      tournamentName: 'Кубок',
      teams: { a: '</script><img src=x onerror=alert(1)>', b: 'Кобры' },
      you: null,
      pool: maps,
      phases: [{ group: 'maps', total: 2, done: 0, resultIds: [] }],
    });

    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
  });

  it('название варианта экранируется в подписи плитки', () => {
    const html = shell(
      [{ id: 'x', label: '<b>Ascent</b>', group: 'maps' }],
      [{ group: 'maps', total: 1 }],
    );

    expect(html).toContain('&lt;b&gt;Ascent&lt;/b&gt;');
  });
});
