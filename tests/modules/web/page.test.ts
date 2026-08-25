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

  /**
   * Регрессия. Иконка вшита как data-URI со SVG внутри, и двойные кавычки в его атрибутах
   * закрывали HTML-атрибут раньше времени: остаток разметки высыпался текстом в левый верхний
   * угол страницы. Проверяем, что за атрибутом иконки сразу идёт закрывающий тег.
   */
  it('иконка не разрывает свой атрибут', () => {
    const html = page('Кубок', '', { game: 'valorant' });
    const icon = /<link rel="icon" href="([^"]*)">/.exec(html);

    expect(icon, 'атрибут иконки не собрался целиком').not.toBeNull();
    // Внутри значения не должно остаться ни кавычек, ни угловых скобок: всё закодировано.
    expect(icon?.[1]).not.toMatch(/["<>]/);
    expect(icon?.[1]).toMatch(/^data:image\/svg\+xml,/);
  });

  it('в head нет разорванных атрибутов', () => {
    const html = page('Кубок', '', { game: 'dota2' });
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

    // Чётное число кавычек в каждой строке head: непарная означает разорванный атрибут.
    for (const line of head.split('\n')) {
      if (!line.includes('=')) continue;
      const quotes = (line.match(/"/g) ?? []).length;
      expect(quotes % 2, `непарная кавычка: ${line.slice(0, 80)}`).toBe(0);
    }
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

  const shell = (
    pool: DraftOption[],
    phases: { group: 'maps' | 'agents' | 'heroes' | 'characters'; total: number }[],
    you: 'a' | 'b' | null = 'a',
  ) =>
    draftShell({
      matchId: 7,
      tournamentName: 'Кубок',
      teams: { a: 'Пантеры', b: 'Кобры' },
      you,
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

/**
 * Пометка «нет на аккаунте» у персонажей Genshin. Проверяется точка зрения смотрящего: одна
 * и та же плитка для одной стороны «нет у тебя», для другой — «нет у соперника», и это две
 * разные подсказки, а не одна на двоих.
 */
describe('состав аккаунта на полотне драфта', () => {
  const shell = (pool: DraftOption[], you: 'a' | 'b' | null): string =>
    draftShell({
      matchId: 7,
      tournamentName: 'Кубок',
      teams: { a: 'Пантеры', b: 'Кобры' },
      you,
      pool,
      phases: [{ group: 'characters', total: pool.length, done: 0, resultIds: [] }],
    });

  const characters: DraftOption[] = [
    { id: '10000002', label: 'Аяка', group: 'characters', owned: ['a'] },
    { id: '10000030', label: 'Чжун Ли', group: 'characters', owned: ['a', 'b'] },
    { id: '10000089', label: 'Фурина', group: 'characters', owned: ['b'] },
    { id: '10000046', label: 'Ху Тао', group: 'characters' },
  ];
  it('своей стороне говорит, чего нет у неё, и чего нет у соперника', () => {
    const html = shell(characters, 'a');

    // Фурины нет у стороны «a» — она смотрит.
    expect(html).toContain('нет у тебя');
    // Аяки нет у стороны «b».
    expect(html).toContain('нет у соперника');
  });

  it('та же плитка для другой стороны читается наоборот', () => {
    const forB = shell([{ id: '10000089', label: 'Фурина', group: 'characters', owned: ['b'] }], 'b');

    expect(forB).toContain('нет у соперника');
    expect(forB).not.toContain('нет у тебя');
  });

  /** Пометка помогает делать ход. Зритель ходов не делает, и шум ему ни к чему. */
  it('зрителю без стороны не показывается ничего', () => {
    const html = shell(characters, null);

    expect(html).not.toContain('нет у тебя');
    expect(html).not.toContain('нет у соперника');
  });

  /**
   * Отсутствие пометки означает «неизвестно», а не «нет ни у кого». Летопись бывает закрыта,
   * ключа бота может не быть вовсе — и тогда драфт идёт как раньше, без пометок.
   */
  it('без сведений о составе плитка ничем не помечена', () => {
    const html = shell([{ id: '10000046', label: 'Ху Тао', group: 'characters' }], 'a');

    expect(html).not.toContain('нет у');
  });

  it('пометка не запрещает ход: плитка остаётся свободной', () => {
    const html = shell([{ id: '10000089', label: 'Фурина', group: 'characters', owned: ['b'] }], 'a');

    expect(html).toContain('class="tile free lacks-you"');
  });
});

/**
 * Стоимость состава на полотне драфта. В Genshin разница между C0 и C6 больше, чем между
 * уровнями, поэтому созвездие и цена стоят там же, где название, — их читают до хода, а не
 * после матча.
 */
describe('стоимость состава в драфте', () => {
  const withBuild = (cost: number, over: Partial<DraftOption> = {}): DraftOption => ({
    id: '10000046',
    label: 'Ху Тао',
    group: 'characters',
    owned: ['a'],
    builds: [
      {
        side: 'a',
        constellation: 1,
        cost,
        weapon: { name: 'Нефритовый секач', refinement: 1, rarity: 5 },
        sets: '4× Багровая ведьма',
      },
    ],
    ...over,
  });

  const shell = (pool: DraftOption[], you: 'a' | 'b' | null, costCap?: number | null): string =>
    draftShell({
      matchId: 7,
      tournamentName: 'Кубок',
      teams: { a: 'Пантеры', b: 'Кобры' },
      you,
      pool,
      phases: [{ group: 'characters', total: pool.length, done: 0, resultIds: [] }],
      ...(costCap === undefined ? {} : { costCap }),
    });

  it('на плитке видно созвездие, оружие и цену', () => {
    const html = shell([withBuild(3)], 'a');

    expect(html).toContain('C1');
    expect(html).toContain('Нефритовый секач R1');
    expect(html).toContain('data-cost="3"');
  });

  /**
   * Показывается только своя сборка. Чужое созвездие — сведения об аккаунте соперника, и
   * выкладывать их на странице, которую открывают по ссылке, незачем: для решения хватает
   * своей цены и того, есть ли персонаж у соперника вообще.
   */
  it('чужая сборка не показывается', () => {
    const html = shell([withBuild(3)], 'b');

    expect(html).not.toContain('Нефритовый секач');
    expect(html).toContain('data-cost="0"');
  });

  it('зрителю без стороны сборки не показываются', () => {
    expect(shell([withBuild(3)], null)).not.toContain('Нефритовый секач');
  });

  /** Персонаж, который в одиночку не влезает в потолок, помечается до хода, а не после. */
  it('слишком дорогой для потолка помечается', () => {
    expect(shell([withBuild(8)], 'a', 6)).toContain('tile free pricey');
    expect(shell([withBuild(3)], 'a', 6)).not.toContain('pricey');
  });

  it('кошелёк показывает потолок', () => {
    const html = shell([withBuild(3)], 'a', 6);

    expect(html).toContain('id="purse"');
    expect(html).toContain('потолок 6');
  });

  it('без потолка кошелёк это говорит, а не молчит', () => {
    expect(shell([withBuild(3)], 'a', null)).toContain('без потолка');
  });

  /** У карт и агентов очков нет: пустая полоса над полотном была бы шумом. */
  it('без посчитанной стоимости кошелька нет вовсе', () => {
    const html = shell([{ id: 'a', label: 'Ascent', group: 'characters' }], 'a', 6);

    expect(html).not.toContain('id="purse"');
  });

  it('половинные очки не превращаются в хвост', () => {
    expect(shell([withBuild(1.5)], 'a', 5.5)).toContain('потолок 5.5');
  });
});
