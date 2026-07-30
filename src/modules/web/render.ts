import { EVENT_SIZE_LABELS, eventSize } from '../tournaments/bracket.js';
import { TOURNAMENT_GAME_LABELS } from '../tournaments/games.js';
import { standingsOf } from '../tournaments/standings.js';
import type { EntrantRow, MatchRow, TournamentGame, TournamentRow } from '../tournaments/schema.js';

/**
 * Витрина отдаёт готовый HTML с сервера, без SPA и без сборки фронтенда: на страницах,
 * где нечего нажимать, одностраничное приложение — лишний слой, лишний шаг сборки и
 * лишний способ сломаться.
 *
 * Визуальный язык взят из мира самих игр — из ранговых медалей. Отсюда латунный акцент
 * вместо кислотного, тёплый цвет текста (как у бумажного листа сетки, приколотого к стене
 * на LAN) поверх холодного фона и моноширинный шрифт для всего, что является данными:
 * имена в сетке выстраиваются в колонки, как на настоящем турнирном листе.
 *
 * Подпись страницы — сама сетка. Линии связей считаются на сервере по точной геометрии
 * (высота матча и шаг круга известны) и прорисовываются слева направо при загрузке,
 * сходясь к финалу. Это и есть главное, что здесь есть: сетка — дерево последствий.
 */

const MATCH_H = 58;
const V_GAP = 12;
const PITCH = MATCH_H + V_GAP;
const COL_W = 208;
const LINK_W = 44;

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

const STYLE = `
:root {
  --ink:#14121a; --sheet:#1c1a24; --sheet-2:#221f2c; --rule:#332e42;
  --bone:#ece7dd; --dim:#9b93a8; --gold:#d9a544; --ember:#e2543a;
  --mono: ui-monospace,'SF Mono','Cascadia Mono','JetBrains Mono',Consolas,'Liberation Mono',monospace;
  --sans: ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --match-h:${MATCH_H}px; --pitch:${PITCH}px; --col-w:${COL_W}px; --link-w:${LINK_W}px;
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body {
  margin:0; background:var(--ink); color:var(--bone); font-family:var(--sans);
  font-size:16px; line-height:1.5;
  background-image:
    radial-gradient(1100px 420px at 82% -8%, rgba(217,165,68,.10), transparent 62%),
    radial-gradient(760px 380px at 8% 104%, rgba(226,84,58,.07), transparent 60%);
  background-attachment:fixed;
}
a { color:inherit; text-decoration:none; }
.wrap { max-width:74rem; margin:0 auto; padding:1.5rem 1.15rem 4rem; }

/* Шапка: полоса состояния, а не украшение — она показывает, что происходит сейчас. */
.top { display:flex; align-items:baseline; gap:1.25rem; flex-wrap:wrap; padding-bottom:1rem;
  border-bottom:1px solid var(--rule); margin-bottom:1.75rem; }
.mark { font-family:var(--mono); font-size:.72rem; letter-spacing:.24em; text-transform:uppercase;
  color:var(--gold); }
.top nav { display:flex; gap:1.1rem; margin-left:auto; font-family:var(--mono); font-size:.76rem;
  letter-spacing:.1em; text-transform:uppercase; color:var(--dim); flex-wrap:wrap; }
.top nav a { padding-bottom:2px; border-bottom:1px solid transparent; transition:color .18s, border-color .18s; }
.top nav a:hover, .top nav a:focus-visible { color:var(--bone); border-color:var(--gold); }

/* Вход элементов на страницу. Одно движение, короткое и в одну сторону: страница должна
   собираться на глазах, а не устраивать представление. Главный движок здесь — линии сетки,
   и всё остальное обязано ему уступать. */
@keyframes enter { from { opacity:0; transform:translateY(9px); } to { opacity:1; transform:none; } }

h1 { font-size:clamp(1.85rem,5.5vw,2.9rem); line-height:1.02; margin:0 0 .5rem;
  font-weight:800; letter-spacing:-.03em; text-transform:uppercase;
  animation:enter .5s cubic-bezier(.2,.7,.3,1) both; }
h2 { font-family:var(--mono); font-size:.76rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--dim); font-weight:500; margin:2.5rem 0 .9rem;
  animation:enter .45s cubic-bezier(.2,.7,.3,1) both; }
/* Латунная риска у заголовка раздела уезжает вправо: раздел начинается, а не просто есть. */
h2::after { content:''; display:block; width:2.2rem; height:1px; background:var(--gold); margin-top:.5rem;
  transform-origin:left; animation:swipe .55s cubic-bezier(.2,.7,.3,1) both; animation-delay:.1s; }
@keyframes swipe { from { transform:scaleX(0); } to { transform:scaleX(1); } }
.lede { color:var(--dim); font-size:.95rem; margin:0 0 1.5rem;
  animation:enter .5s cubic-bezier(.2,.7,.3,1) .06s both; }
.mono { font-family:var(--mono); }

/* Точка «идёт сейчас» пульсирует — единственный постоянный движок на странице. */
.live { display:inline-flex; align-items:center; gap:.45rem; font-family:var(--mono);
  font-size:.7rem; letter-spacing:.16em; text-transform:uppercase; color:var(--ember); }
.live::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--ember);
  box-shadow:0 0 0 0 rgba(226,84,58,.55); animation:pulse 2s ease-out infinite; }
@keyframes pulse { 70%{box-shadow:0 0 0 9px rgba(226,84,58,0);} 100%{box-shadow:0 0 0 0 rgba(226,84,58,0);} }

.chip { display:inline-block; font-family:var(--mono); font-size:.68rem; letter-spacing:.14em;
  text-transform:uppercase; color:var(--dim); border:1px solid var(--rule);
  border-radius:2px; padding:.2rem .5rem; }

/* Карточка турнира: латунная риска слева уезжает вправо при наведении. */
.card { position:relative; display:block; background:var(--sheet); border:1px solid var(--rule);
  border-radius:3px; padding:1rem 1.15rem 1rem 1.35rem; margin-bottom:.7rem; overflow:hidden;
  transition:border-color .2s, transform .2s;
  animation:enter .42s cubic-bezier(.2,.7,.3,1) both; animation-delay:var(--delay,0ms); }
.card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:var(--gold); transform:scaleY(.28); transform-origin:top; transition:transform .28s ease; }
.card:hover, .card:focus-visible { border-color:var(--gold); transform:translateX(2px); }
.card:hover::before, .card:focus-visible::before { transform:scaleY(1); }
.card .name { font-size:1.12rem; font-weight:700; letter-spacing:-.01em; }
.card .meta { color:var(--dim); font-size:.85rem; margin-top:.25rem; font-family:var(--mono); }

/* Сетка. Колонки и связи позиционируются по точной геометрии, посчитанной на сервере. */
.bracket { overflow-x:auto; overflow-y:hidden; padding:.25rem 0 1rem; -webkit-overflow-scrolling:touch; }
.grid { position:relative; display:flex; align-items:stretch; }
.col { position:relative; flex:0 0 var(--col-w); width:var(--col-w); }
.col > .rlabel { position:absolute; top:-1.55rem; left:0; font-family:var(--mono); font-size:.68rem;
  letter-spacing:.2em; text-transform:uppercase; color:var(--dim); }
.links { position:relative; flex:0 0 var(--link-w); width:var(--link-w); }
.links svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.links path { fill:none; stroke:var(--rule); stroke-width:1.5;
  stroke-dasharray:var(--len); stroke-dashoffset:var(--len);
  animation:draw .55s ease-out forwards; animation-delay:var(--delay); }
@keyframes draw { to { stroke-dashoffset:0; } }

.m { position:absolute; left:0; width:100%; height:var(--match-h);
  background:var(--sheet); border:1px solid var(--rule); border-radius:3px; overflow:hidden;
  opacity:0; transform:translateY(6px); animation:rise .42s ease-out forwards;
  animation-delay:var(--delay); transition:border-color .18s, box-shadow .18s; }
@keyframes rise { to { opacity:1; transform:none; } }
.m:hover { border-color:var(--gold); box-shadow:0 0 0 1px rgba(217,165,68,.25); }
.m.live-m { border-color:rgba(226,84,58,.5); }
/* Матч, который не состоится: место под проигравшего, которого не случилось. Оставлен
   в сетке нарочно — без него в ней была бы дыра, а дыра читается как ошибка. */
.m.dead-m { opacity:.32; border-style:dashed; }
.m .s { display:flex; align-items:center; justify-content:space-between; gap:.5rem;
  height:calc(var(--match-h)/2 - 1px); padding:0 .6rem; font-family:var(--mono); font-size:.82rem; }
.m .s + .s { border-top:1px solid var(--rule); }
.m .s .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.m .s .sd { color:var(--dim); font-size:.7rem; }
.m .s.won { color:var(--gold); }
.m .s.won .sd { color:var(--gold); }
.m .s.tbd { color:var(--dim); }
.m .seed { color:var(--dim); font-size:.68rem; margin-right:.4rem; }

/* Лидерборд: медальная плашка слева — тот же язык, что и в игре. */
table { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:.88rem; }
thead th { text-align:left; padding:.5rem .5rem .6rem; border-bottom:1px solid var(--rule);
  color:var(--dim); font-weight:500; font-size:.68rem; letter-spacing:.16em; text-transform:uppercase; }
tbody td { padding:.62rem .5rem; border-bottom:1px solid rgba(51,46,66,.6); }
tbody tr { animation:rise .3s ease-out backwards; animation-delay:var(--delay); }
tbody tr:hover td { background:var(--sheet-2); }
td.pos { color:var(--dim); text-align:right; width:2.6rem; font-size:.8rem; }
td.acct { font-family:var(--sans); font-weight:600; }
.medal { display:inline-flex; align-items:center; gap:.5rem; }
.medal::before { content:''; width:9px; height:9px; border-radius:2px; transform:rotate(45deg);
  background:var(--tc); box-shadow:0 0 8px -1px var(--tc); flex:0 0 auto; }
td.num { text-align:right; color:var(--dim); font-variant-numeric:tabular-nums; }
td.acct a { border-bottom:1px solid transparent; transition:color .18s, border-color .18s; }
td.acct a:hover, td.acct a:focus-visible { color:var(--gold); border-color:var(--gold); }
/* Чемпион — единственная строка таблицы, которой позволено быть латунной. */
td.champ { color:var(--gold); font-weight:600; }
.dim { color:var(--dim); }

/* Пьедестал: чемпион крупнее и латунный, остальные — ровно настолько, чтобы читались как
   места, а не как утешение. Появляются по очереди сверху вниз. */
.podium { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));
  margin-bottom:.5rem; }
.pl { display:grid; grid-template-columns:auto 1fr; grid-template-rows:auto auto; gap:.1rem .7rem;
  align-items:center; background:var(--sheet); border:1px solid var(--rule); border-radius:3px;
  padding:.9rem 1rem; animation:enter .45s cubic-bezier(.2,.7,.3,1) both; animation-delay:var(--delay,0ms); }
.pl.first { border-color:var(--gold); box-shadow:0 0 0 1px rgba(217,165,68,.18); }
.pl .mk { grid-row:1 / span 2; font-size:1.7rem; line-height:1; }
.pl .who { font-weight:700; font-size:1.05rem; letter-spacing:-.01em; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.pl.first .who { color:var(--gold); font-size:1.2rem; }
.pl .pn { font-family:var(--mono); font-size:.68rem; letter-spacing:.16em; text-transform:uppercase;
  color:var(--dim); }
/* «Заявлено» намеренно тихое: это оговорка к рангу, а не его часть. */
.claimed { font-family:var(--mono); font-size:.62rem; letter-spacing:.1em; text-transform:uppercase;
  color:var(--dim); border:1px solid var(--rule); border-radius:2px; padding:.1rem .3rem;
  margin-left:.45rem; white-space:nowrap; }

.empty { border:1px dashed var(--rule); border-radius:3px; padding:2rem 1.25rem; text-align:center; }
.empty p { margin:.35rem 0; color:var(--dim); }
.empty code { font-family:var(--mono); color:var(--gold); }

footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--rule);
  color:var(--dim); font-size:.78rem; font-family:var(--mono); }

:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }
@media (max-width:640px) { :root { --col-w:170px; --link-w:30px; } .wrap { padding:1.15rem .85rem 3rem; } }
@media (prefers-reduced-motion:reduce) {
  .links path { animation:none; stroke-dashoffset:0; }
  /* Всё, что появляется движением, обязано просто быть — иначе анимация станет условием
     видимости, и человек с выключенным движением увидит пустую страницу. */
  .m, tbody tr, h1, h2, .lede, .card, .fmt, .slot { animation:none; opacity:1; transform:none; }
  h2::after { animation:none; transform:none; }
  .live::before { animation:none; }
  * { transition:none !important; }
}
`;

export function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(title)}</title>
<style>${STYLE}</style>
${extraHead}
</head>
<body>
<div class="wrap">
  <header class="top">
    <a href="/" class="mark">Турниры сервера</a>
    <nav>
      <a href="/rules">Правила</a>
      <a href="/hall">Зал славы</a>
      <a href="/leaderboard/dota2">Dota 2</a>
      <a href="/leaderboard/lol">LoL</a>
      <a href="/leaderboard/tft">TFT</a>
      <a href="/leaderboard/valorant">Valorant</a>
    </nav>
  </header>
${body}
  <footer>Ранги приходят из API игр и обновляются каждые полчаса. Показаны только подтверждённые привязки.</footer>
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

export function renderTournamentList(rows: (TournamentRow & { entrantCount: number })[]): string {
  if (rows.length === 0) {
    return `<h1>Пока пусто</h1>
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
      // Лестница задержек: карточки появляются сверху вниз, как будто список наливается.
      return `<a class="card" href="/t/${row.id}" style="--delay:${index * 45}ms">
  <div class="name">${escape(row.name)}</div>
  <div class="meta">${escape(TOURNAMENT_GAME_LABELS[row.game] ?? row.game)} · ${escape(kind)} · ${row.entrantCount} уч. · ${escape(roster)}</div>
  <div style="margin-top:.55rem">${status}</div>
</a>`;
    })
    .join('\n');

  return `<h1>Турниры</h1>
<p class="lede">Сетки, составы и результаты. Обновляется по ходу вечера.</p>
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

  const head = `<h1>${escape(view.tournament.name)}</h1>
<p class="lede">${escape(TOURNAMENT_GAME_LABELS[view.tournament.game] ?? view.tournament.game)} · ${escape(EVENT_SIZE_LABELS[size])} · ${active.length} участников · ${status}</p>`;

  if (view.matches.length === 0) {
    const list = active
      .map(
        (entrant) => `<div class="card"><div class="name">${escape(entrant.displayName)}</div>
<div class="meta">${entrant.checkedInAt ? 'состав отмечен' : 'ждём отметки капитана'}</div></div>`,
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
    { mark: '🥇', place: 'Чемпион', who: nameOf(places.championId), top: true },
    ...(places.runnerUpId !== null
      ? [{ mark: '🥈', place: 'Второе место', who: nameOf(places.runnerUpId), top: false }]
      : []),
    ...(places.thirdId !== null
      ? [{ mark: '🥉', place: 'Третье место', who: nameOf(places.thirdId), top: false }]
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
    return `<h1>${escape(label)}</h1>
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

  return `<h1>${escape(label)}</h1>
<p class="lede">Только подтверждённые привязки. Обновляется автоматически каждые полчаса.</p>
<table>
<thead><tr><th class="pos">#</th><th>Аккаунт</th><th>Ранг</th><th class="num">Очки</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
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
    return `<h1>Зал славы</h1>
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
<td class="champ">🏆 ${champion}</td>
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

  return `<h1>Зал славы</h1>
<p class="lede">Что уже сыграно. Личные цифры — команда <code>/stats</code> в Discord.</p>
<table>
<thead><tr><th>Турнир</th><th>Игра</th><th>Чемпион</th><th class="num">Уч.</th><th class="num">Матчей</th><th class="num">Когда</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${
  board
    ? `<h2>Больше всех титулов</h2>
<p class="lede">По названию команды: состав собирается заново каждый раз, а название люди переносят из недели в неделю.</p>
<table>
<thead><tr><th class="pos">#</th><th>Команда</th><th class="num">Титулов</th></tr></thead>
<tbody>${board}</tbody>
</table>`
    : ''
}`;
}

export function renderNotFound(what: string): string {
  return `<h1>Не найдено</h1>
<div class="empty"><p>${escape(what)}</p></div>`;
}
