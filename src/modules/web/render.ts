import { EVENT_SIZE_LABELS, eventSize } from '../tournaments/bracket.js';
import { TOURNAMENT_GAME_LABELS } from '../tournaments/games.js';
import { standingsOf } from '../tournaments/standings.js';
import type { EntrantRow, MatchRow, TournamentGame, TournamentRow } from '../tournaments/schema.js';
import { GAME_IDENTITY, SERVER_BAND, SERVER_CREDIT } from './art.js';
import { LINK_W, MATCH_H, PITCH, STYLE } from './theme.js';

/**
 * Витрина отдаёт готовый HTML с сервера, без SPA и без сборки фронтенда: на страницах,
 * где нечего нажимать, одностраничное приложение — лишний слой, лишний шаг сборки и
 * лишний способ сломаться.
 *
 * Подпись страницы турнира — сама сетка. Линии связей считаются на сервере по точной
 * геометрии (высота матча и шаг круга известны) и прорисовываются слева направо при
 * загрузке, сходясь к финалу. Это и есть главное, что здесь есть: сетка — дерево
 * последствий. Всё остальное на странице ей уступает.
 *
 * Оформление и объяснение выбранного языка — в `theme.ts`, ссылки на игровой арт — в `art.ts`.
 */

export function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Цвета медалей и эмблем — те, которые игроки знают наизусть. */
const TIER_COLORS: Record<string, string> = {
  HERALD: '#8b8f95',
  GUARDIAN: '#6f8f6a',
  CRUSADER: '#a9895f',
  ARCHON: '#6f7fb3',
  LEGEND: '#9a6fb0',
  ANCIENT: '#4f9c96',
  DIVINE: '#6f8fe0',
  IMMORTAL: '#e2543a',
  IRON: '#6b6b6b',
  BRONZE: '#8c6239',
  SILVER: '#9aa4ad',
  GOLD: '#d9a544',
  PLATINUM: '#4fb3a8',
  EMERALD: '#3fa96a',
  DIAMOND: '#6f8fe0',
  MASTER: '#a259c8',
  GRANDMASTER: '#d0453c',
  CHALLENGER: '#f0d67a',
  ASCENDANT: '#3fa96a',
  RADIANT: '#f0d67a',
};

function tierColor(tier: string | null): string {
  if (!tier) return 'var(--rule)';
  return TIER_COLORS[tier.toUpperCase()] ?? 'var(--rule)';
}

const NAV = [
  { href: '/rules', label: 'Правила' },
  { href: '/hall', label: 'Зал славы' },
  { href: '/leaderboard/dota2', label: 'Dota 2' },
  { href: '/leaderboard/valorant', label: 'Valorant' },
  { href: '/leaderboard/lol', label: 'LoL' },
  { href: '/leaderboard/tft', label: 'TFT' },
];

export interface PageChrome {
  /**
   * Дисциплина страницы. Задаёт акцентный цвет и полосу арта — по ним видно, чья это
   * страница, до чтения заголовка. Без дисциплины берутся цвета сервера и смешанная полоса:
   * список турниров и зал славы не про одну игру, и назначать им главную было бы неверно.
   */
  game?: TournamentGame;
  /** Стиль конкретной страницы: правил, драфта. */
  head?: string;
  /** Какая ссылка в навигации сейчас открыта. */
  current?: string;
}

/** Полоса игрового арта. Только для глаз — в дерево доступности не попадает. */
function band(images: readonly string[]): string {
  const panels = images
    .slice(0, 6)
    .map(
      (src, index) =>
        `<figure style="--delay:${index * 55}ms"><img src="${escape(src)}" alt="" loading="${
          index === 0 ? 'eager' : 'lazy'
        }" decoding="async"></figure>`,
    )
    .join('');
  return `<div class="band" aria-hidden="true">${panels}</div>`;
}

export function page(title: string, body: string, chrome: PageChrome = {}): string {
  const identity = chrome.game ? GAME_IDENTITY[chrome.game] : null;
  const accent = identity?.accent;
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${chrome.current === item.href ? ' aria-current="page"' : ''}>${escape(item.label)}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(title)}</title>
<style>${STYLE}</style>
${chrome.head ?? ''}
</head>
<body${accent ? ` style="--accent:${accent}"` : ''}>
${band(identity?.band ?? SERVER_BAND)}
<div class="wrap">
  <header class="top">
    <a href="/" class="mark">Турниры сервера</a>
    <nav>${nav}</nav>
  </header>
${body}
  <footer>
    <p>Ранги приходят из API игр и обновляются каждые полчаса. Показаны только подтверждённые привязки.</p>
    <p class="credit">${escape(identity?.credit ?? SERVER_CREDIT)}</p>
  </footer>
</div>
</body>
</html>`;
}

const STATE_LABELS: Record<string, string> = {
  draft: 'черновик',
  registration: 'идёт регистрация',
  running: 'идёт',
  finished: 'завершён',
  cancelled: 'отменён',
};

/** Картинка дисциплины для карточки: первая из её полосы, чтобы список и шапка были из одного мира. */
function sigil(game: TournamentGame): string {
  return GAME_IDENTITY[game]?.band[0] ?? '';
}

/**
 * Согласование числительного с существительным. Без него получается «идёт 8 турнира» — та
 * мелочь, из-за которой страница читается как машинный перевод.
 */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function renderTournamentList(rows: (TournamentRow & { entrantCount: number })[]): string {
  if (rows.length === 0) {
    return `<p class="eyebrow">Турниры сервера</p>
<h1>Пока пусто</h1>
<p class="lede">Бот объявляет турнир каждый день: сначала голосование по дисциплине, потом регистрация. Как только объявит — сетка появится здесь.</p>
<div class="empty"><p>Привязать игровой аккаунт можно уже сейчас — командой <code>/link</code> в Discord.</p>
<p>Тогда к первому турниру жеребьёвка разведёт фаворитов по разным половинам сетки.</p></div>`;
  }

  const cards = rows
    .map((row, index) => {
      const size = eventSize(row.entrantCount);
      const kind = row.state === 'running' || row.state === 'finished' ? EVENT_SIZE_LABELS[size] : 'турнир';
      const status =
        row.state === 'running'
          ? '<span class="live">идёт</span>'
          : `<span class="chip">${escape(STATE_LABELS[row.state] ?? row.state)}</span>`;
      const roster = row.entryMode === 'team' ? `по ${row.teamSize} в команде` : 'одиночки';
      const art = sigil(row.game);
      // Акцент у каждой карточки свой — её дисциплины. Список турниров не про одну игру, и
      // латунь на всех подряд стёрла бы единственное, чем они здесь различаются на глаз.
      const accent = GAME_IDENTITY[row.game]?.accent;
      // Лестница задержек: карточки появляются сверху вниз, как будто список наливается.
      return `<a class="card" href="/t/${row.id}" style="--delay:${index * 45}ms${accent ? `;--accent:${accent}` : ''}">
  <span class="sig">${art ? `<img src="${escape(art)}" alt="" loading="lazy" decoding="async">` : ''}</span>
  <span>
    <span class="name">${escape(row.name)}</span>
    <span class="meta">${escape(TOURNAMENT_GAME_LABELS[row.game] ?? row.game)} · ${escape(kind)} · ${row.entrantCount} уч. · ${escape(roster)}</span>
    <span class="tail">${status}</span>
  </span>
</a>`;
    })
    .join('\n');

  const live = rows.filter((row) => row.state === 'running').length;
  const lede =
    live > 0
      ? `Сейчас ${plural(live, 'идёт', 'идут', 'идут')} ${live} ${plural(live, 'турнир', 'турнира', 'турниров')}. Сетки обновляются по ходу вечера.`
      : 'Сетки, составы и результаты. Обновляется по ходу вечера.';

  return `<p class="eyebrow">Турниры сервера</p>
<h1>Турниры</h1>
<p class="lede">${escape(lede)}</p>
${cards}`;
}

function roundTitle(round: number, rounds: number): string {
  if (round === rounds) return 'Финал';
  if (round === rounds - 1) return 'Полуфинал';
  if (round === rounds - 2) return '1/4';
  if (round === rounds - 3) return '1/8';
  return `Круг ${round}`;
}

const MATCH_NOTE: Record<string, string> = {
  reported: 'ждём подтверждения',
  disputed: 'разбирается',
  walkover: 'без игры',
  void: 'не проводится — некому спуститься',
};

/** Круги нижней сетки не делятся на «1/2» и «1/4»: в них сходятся упавшие с разных этажей. */
function lowerRoundTitle(round: number, rounds: number): string {
  if (round === rounds) return 'Финал низа';
  return `Круг ${round}`;
}

/**
 * Геометрия сетки считается здесь, а не в CSS: шаг круга удваивается с каждым кругом
 * (`PITCH * 2^(r-1)`), и центр матча — это `шаг * (позиция + 0.5)`. Зная это, связи между
 * кругами можно нарисовать точными путями, а не подгонять псевдоэлементами.
 */
export function renderBracket(view: {
  tournament: TournamentRow;
  entrants: EntrantRow[];
  matches: MatchRow[];
}): string {
  const names = new Map<number, { name: string; seed: number | null }>();
  for (const entrant of view.entrants) names.set(entrant.id, { name: entrant.displayName, seed: entrant.seed });

  const active = view.entrants.filter((entrant) => entrant.withdrawnAt === null);
  const size = eventSize(active.length);

  const status =
    view.tournament.state === 'running'
      ? '<span class="live">идёт</span>'
      : `<span class="chip">${escape(STATE_LABELS[view.tournament.state] ?? view.tournament.state)}</span>`;

  const roster =
    view.tournament.entryMode === 'team' ? `по ${view.tournament.teamSize} в команде` : 'один на один';

  const head = `<p class="eyebrow">${escape(TOURNAMENT_GAME_LABELS[view.tournament.game] ?? view.tournament.game)} · ${escape(roster)}</p>
<h1>${escape(view.tournament.name)}</h1>
<p class="lede">${escape(EVENT_SIZE_LABELS[size])} · ${active.length} участников · ${status}</p>`;

  if (view.matches.length === 0) {
    const list = active
      .map(
        (entrant) => `<div class="card"><span><span class="name">${escape(entrant.displayName)}</span>
<span class="meta">${entrant.checkedInAt ? 'состав отмечен' : 'ждём отметки капитана'}</span></span></div>`,
      )
      .join('\n');
    return `${head}<h2>Участники</h2>
${list || '<div class="empty"><p>Ещё никто не записался. Команда собирается кнопкой в Discord.</p></div>'}`;
  }

  let step = 0;

  /** Карточка матча: две стороны, победитель подсвечен, состояние — подсказкой. */
  const card = (match: MatchRow, top: number): string => {
    const delay = `${(step += 1) * 45}ms`;

    const side = (id: number | null): string => {
      if (id === null) return `<div class="s tbd"><span class="nm">—</span></div>`;
      const entrant = names.get(id);
      const won = match.winnerEntrantId === id;
      const seed = entrant?.seed === null || entrant?.seed === undefined ? '' : `<span class="seed">${entrant.seed}</span>`;
      const note = won ? (match.state === 'walkover' ? 'без игры' : 'победа') : '';
      return `<div class="s${won ? ' won' : ''}"><span class="nm">${seed}${escape(entrant?.name ?? `#${id}`)}</span><span class="sd">${escape(note)}</span></div>`;
    };

    const attention = match.state === 'reported' || match.state === 'disputed';
    const note = MATCH_NOTE[match.state];
    const title = note ? ` title="${escape(note)}"` : '';
    const classes = ['m', attention ? 'live-m' : '', match.state === 'void' ? 'dead-m' : '']
      .filter(Boolean)
      .join(' ');
    return `<div class="${classes}" style="top:${top}px;--delay:${delay}"${title}>${side(match.entrantAId)}${side(match.entrantBId)}</div>`;
  };

  /**
   * Одна сетка целиком. Шаг круга считается от числа матчей в нём, а не удвоением: в
   * нижней сетке круги идут парами одинаковой длины (4, 4, 2, 2, 1, 1), и формула
   * удвоения там разъехалась бы с реальными позициями. Для верхней сетки обе формулы
   * совпадают, потому что там число матчей и правда делится вдвое каждый круг.
   */
  const renderPart = (
    matches: MatchRow[],
    label: (round: number, rounds: number) => string,
  ): string => {
    const rounds = matches.reduce((max, match) => Math.max(max, match.round), 0);
    const countOf = (round: number): number =>
      Math.max(matches.filter((match) => match.round === round).length, 1);
    const totalH = PITCH * countOf(1);
    const centerOf = (round: number, slot: number): number =>
      (totalH / countOf(round)) * (slot + 0.5);

    const parts: string[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      const cells = matches
        .filter((match) => match.round === round)
        .sort((a, b) => a.slot - b.slot)
        .map((match) => card(match, centerOf(round, match.slot) - MATCH_H / 2))
        .join('\n');

      parts.push(
        `<div class="col" style="height:${totalH}px"><span class="rlabel">${escape(label(round, rounds))}</span>${cells}</div>`,
      );

      if (round >= rounds) continue;

      const here = countOf(round);
      const next = countOf(round + 1);
      const paths: string[] = [];

      if (next === here) {
        // Круг не сужается: выживший едет прямо, а соперника ему привезут сверху.
        for (let slot = 0; slot < here; slot += 1) {
          const y = centerOf(round, slot);
          paths.push(
            `<path d="M0 ${y} H${LINK_W}" style="--len:${LINK_W};--delay:${slot * 60 + round * 120}ms"/>`,
          );
        }
      } else {
        // Пара схлопывается в одну: из центров двух матчей — в центр их общего родителя.
        for (let child = 0; child < next; child += 1) {
          const yA = centerOf(round, child * 2);
          const yB = centerOf(round, child * 2 + 1);
          const mid = LINK_W / 2;
          const len = Math.round(LINK_W + Math.abs(yB - yA));
          paths.push(
            `<path d="M0 ${yA} H${mid} V${yB} M${mid} ${(yA + yB) / 2} H${LINK_W}" style="--len:${len};--delay:${child * 60 + round * 120}ms"/>`,
          );
        }
      }

      parts.push(
        `<div class="links" style="height:${totalH}px"><svg viewBox="0 0 ${LINK_W} ${totalH}" preserveAspectRatio="none" aria-hidden="true">${paths.join('')}</svg></div>`,
      );
    }

    return `<div class="bracket"><div class="grid" style="min-height:${totalH}px">${parts.join('\n')}</div></div>`;
  };

  // Пьедестал после турнира: сетку читать умеют не все, а «кто победил» спрашивают все.
  // Показываем только у закрытого турнира — у идущего это было бы гаданием.
  const podium =
    view.tournament.state === 'finished' ? renderPodium(view.matches, names) : '';

  const upper = view.matches.filter((match) => match.bracket === 'upper');
  const lower = view.matches.filter((match) => match.bracket === 'lower');
  const grand = view.matches.find((match) => match.bracket === 'grand');
  const twoSided = lower.length > 0;

  const sections = [`<h2>${twoSided ? 'Верхняя сетка' : 'Сетка'}</h2>`, renderPart(upper, roundTitle)];

  if (twoSided) {
    sections.push(
      '<h2>Нижняя сетка</h2>',
      '<p class="lede">Сюда падает проигравший в верхней. Отсюда можно дойти до финала — выбывание только со второго поражения.</p>',
      renderPart(lower, lowerRoundTitle),
    );
  }

  if (grand) {
    sections.push(
      '<h2>Гранд-финал</h2>',
      '<p class="lede">Победитель верхней сетки против того, кто прошёл всю нижнюю.</p>',
      `<div class="bracket"><div class="grid" style="min-height:${PITCH}px"><div class="col" style="height:${PITCH}px">${card(grand, PITCH / 2 - MATCH_H / 2)}</div></div></div>`,
    );
  }

  return `${head}${podium}${sections.join('\n')}`;
}

/**
 * Пьедестал. Третье место показывается только там, где оно честно определено — при двойном
 * устранении. На выбывание полуфиналисты между собой не играли, и назначать одного из них
 * третьим значило бы выдумать результат, которого не было.
 *
 * Счёта здесь нет и быть не может: бот его не собирает. `/match report` спрашивает только
 * «кто победил», и придумывать счёт на странице означало бы показать то, чего никто не
 * вводил.
 */
function renderPodium(
  matches: MatchRow[],
  names: Map<number, { name: string; seed: number | null }>,
): string {
  const places = standingsOf(matches);
  if (places.championId === null) return '';

  const nameOf = (id: number | null): string =>
    id === null ? '—' : (names.get(id)?.name ?? `#${id}`);

  const rows = [
    { mark: '1', place: 'Чемпион', who: nameOf(places.championId), top: true },
    ...(places.runnerUpId !== null
      ? [{ mark: '2', place: 'Второе место', who: nameOf(places.runnerUpId), top: false }]
      : []),
    ...(places.thirdId !== null
      ? [{ mark: '3', place: 'Третье место', who: nameOf(places.thirdId), top: false }]
      : []),
  ];

  const semis =
    places.semifinalistIds.length > 0
      ? `<p class="lede" style="margin:.7rem 0 0">Полуфиналисты: ${places.semifinalistIds
          .map((id) => escape(nameOf(id)))
          .join(', ')}. Между собой они не играли, поэтому третьего места нет — и выдумывать его бот не станет.</p>`
      : '';

  return `<h2>Итог</h2>
<div class="podium">
${rows
  .map(
    (row, index) =>
      `<div class="pl${row.top ? ' first' : ''}" style="--delay:${index * 90}ms">
<span class="mk">${row.mark}</span>
<span class="who">${escape(row.who)}</span>
<span class="pn">${escape(row.place)}</span>
</div>`,
  )
  .join('\n')}
</div>${semis}`;
}

export interface LeaderboardEntry {
  displayName: string;
  mode: string;
  tier: string | null;
  division: string | null;
  points: number | null;
  /** Ранг введён игроком руками, а не получен из API. */
  claimed: boolean;
  score: number;
}

/**
 * Лидерборд показывает игровой ник и ранг, но не идентификатор Discord и не имя на
 * сервере. Ранг и ник игрок и так публикует в самой игре, а связка «этот Discord — этот
 * игровой аккаунт» приватна: публичная страница не должна становиться способом пробить
 * человека. Поэтому это таблица игровых аккаунтов, а не таблица людей.
 */
export function renderLeaderboard(game: TournamentGame, entries: LeaderboardEntry[]): string {
  const label = TOURNAMENT_GAME_LABELS[game] ?? game;

  if (entries.length === 0) {
    return `<p class="eyebrow">Лидерборд</p>
<h1>${escape(label)}</h1>
<p class="lede">Таблица собирается из подтверждённых привязок.</p>
<div class="empty"><p>Пока ни одной привязки этой игры — или ранги ещё не подтянулись.</p>
<p>Привязка делается командой <code>/link</code> в Discord, дальше ранг обновляется сам.</p></div>`;
  }

  const rows = entries
    .map((entry, index) => {
      const rank = [entry.tier, entry.division].filter(Boolean).join(' ') || 'без ранга';
      const points = entry.points === null ? '' : String(entry.points);
      // Пометка обязательна: без неё заявленный ранг стоит в таблице как проверенный.
      const claimed = entry.claimed
        ? ' <span class="claimed" title="ранг указал сам игрок: подтвердить его в этой игре нечем">заявлено</span>'
        : '';
      return `<tr style="--delay:${index * 18}ms">
<td class="pos">${index + 1}</td>
<td class="acct">${escape(entry.displayName)}</td>
<td><span class="medal" style="--tc:${tierColor(entry.tier)}">${escape(rank)}</span>${claimed}</td>
<td class="num">${escape(points)}</td>
</tr>`;
    })
    .join('\n');

  return `<p class="eyebrow">Лидерборд</p>
<h1>${escape(label)}</h1>
<p class="lede">Только подтверждённые привязки. Обновляется автоматически каждые полчаса.</p>
<div class="scroll"><table>
<thead><tr><th class="pos">#</th><th>Аккаунт</th><th>Ранг</th><th class="num">Очки</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

/**
 * Зал славы: летопись сервера. Только командные результаты — они и есть публичное
 * событие. Кто стоял в составе, здесь не показывается: связка «этот человек — эта
 * команда» приватна ровно так же, как связка с игровым аккаунтом, а личные цифры
 * отдаёт `/stats` в Discord, где спрашивающий уже участник сервера.
 */
export function renderHall(
  finished: {
    id: number;
    name: string;
    game: TournamentGame;
    finishedAt: Date | null;
    champion: string | null;
    entrants: number;
    matches: number;
  }[],
  titles: { name: string; titles: number }[],
): string {
  if (finished.length === 0) {
    return `<p class="eyebrow">Летопись сервера</p>
<h1>Зал славы</h1>
<p class="lede">Здесь остаётся то, что уже сыграно: чемпионы, даты, число участников.</p>
<div class="empty"><p>Ни один турнир пока не доигран до конца.</p>
<p>После первого финала эта страница перестанет быть пустой — и дальше будет только расти.</p></div>`;
  }

  const rows = finished
    .map((row, index) => {
      const when =
        row.finishedAt === null
          ? '—'
          : row.finishedAt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
      const champion = row.champion === null ? '<span class="dim">не определён</span>' : escape(row.champion);
      return `<tr style="--delay:${index * 18}ms">
<td class="acct"><a href="/t/${row.id}">${escape(row.name)}</a></td>
<td>${escape(TOURNAMENT_GAME_LABELS[row.game] ?? row.game)}</td>
<td class="champ">${champion}</td>
<td class="num">${row.entrants}</td>
<td class="num">${row.matches}</td>
<td class="num">${escape(when)}</td>
</tr>`;
    })
    .join('\n');

  const board = titles
    .map(
      (team, index) => `<tr style="--delay:${index * 18}ms">
<td class="pos">${index + 1}</td>
<td class="acct">${escape(team.name)}</td>
<td class="num">${team.titles}</td>
</tr>`,
    )
    .join('\n');

  return `<p class="eyebrow">Летопись сервера</p>
<h1>Зал славы</h1>
<p class="lede">Что уже сыграно. Личные цифры — команда <code>/stats</code> в Discord.</p>
<div class="scroll"><table>
<thead><tr><th>Турнир</th><th>Игра</th><th>Чемпион</th><th class="num">Уч.</th><th class="num">Матчей</th><th class="num">Когда</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
${
  board
    ? `<h2>Больше всех титулов</h2>
<p class="lede">По названию команды: состав собирается заново каждый раз, а название люди переносят из недели в неделю.</p>
<div class="scroll"><table>
<thead><tr><th class="pos">#</th><th>Команда</th><th class="num">Титулов</th></tr></thead>
<tbody>${board}</tbody>
</table></div>`
    : ''
}`;
}

export function renderNotFound(what: string): string {
  return `<h1>Не найдено</h1>
<div class="empty"><p>${escape(what)}</p></div>`;
}
