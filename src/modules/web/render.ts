import { EVENT_SIZE_LABELS, eventSize } from '../tournaments/bracket.js';
import { TOURNAMENT_GAME_LABELS } from '../tournaments/games.js';
import type { EntrantRow, MatchRow, TournamentGame, TournamentRow } from '../tournaments/schema.js';

/**
 * Витрина отдаёт готовый HTML с сервера, без SPA и без сборки фронтенда: на страницах,
 * где нечего нажимать, одностраничное приложение — это лишний слой, лишний шаг сборки
 * и лишний способ сломаться.
 *
 * Половина участников откроет ссылку с телефона, поэтому вёрстка мобильная: одна колонка,
 * относительные размеры, сетка турнира прокручивается по горизонтали внутри себя, а не
 * растягивает страницу.
 */

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root { color-scheme: dark light; --bg:#0f1115; --card:#171a21; --line:#262b36; --text:#e6e8ec; --dim:#9aa3b2; --accent:#4f8cff; --win:#3fb950; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.wrap { max-width: 62rem; margin:0 auto; padding:1.25rem 1rem 3rem; }
h1 { font-size:1.5rem; margin:0 0 .25rem; }
h2 { font-size:1.1rem; margin:2rem 0 .75rem; }
.dim { color:var(--dim); }
.badge { display:inline-block; padding:.15rem .5rem; border:1px solid var(--line); border-radius:999px; font-size:.8rem; color:var(--dim); }
.card { background:var(--card); border:1px solid var(--line); border-radius:.6rem; padding:.85rem 1rem; margin:.5rem 0; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:.5rem .4rem; border-bottom:1px solid var(--line); }
th { color:var(--dim); font-weight:500; font-size:.85rem; }
td.num { text-align:right; font-variant-numeric:tabular-nums; color:var(--dim); }
.bracket { display:flex; gap:1.5rem; overflow-x:auto; padding-bottom:.5rem; }
.round { min-width:14rem; flex:0 0 auto; }
.round h3 { font-size:.85rem; color:var(--dim); font-weight:500; margin:0 0 .5rem; }
.match { background:var(--card); border:1px solid var(--line); border-radius:.5rem; margin-bottom:.6rem; overflow:hidden; }
.side { display:flex; justify-content:space-between; gap:.5rem; padding:.45rem .6rem; font-size:.92rem; }
.side + .side { border-top:1px solid var(--line); }
.side.won { color:var(--win); font-weight:600; }
.side.empty { color:var(--dim); font-style:italic; }
.state { font-size:.75rem; color:var(--dim); padding:.25rem .6rem; border-top:1px solid var(--line); }
nav { display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1.5rem; font-size:.9rem; }
footer { margin-top:2.5rem; color:var(--dim); font-size:.85rem; }
@media (prefers-color-scheme: light) {
  :root { --bg:#f7f8fa; --card:#fff; --line:#e3e6ec; --text:#1a1d23; --dim:#616b7c; }
}
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">
<nav><a href="/">Турниры</a><a href="/leaderboard/dota2">Dota 2</a><a href="/leaderboard/lol">LoL</a><a href="/leaderboard/tft">TFT</a></nav>
${body}
<footer>Данные собираются ботом из API игр. Показаны только подтверждённые привязки.</footer>
</div></body>
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
    return `<h1>Турниров пока нет</h1>
<p class="dim">Когда бот объявит турнир, он появится здесь вместе с сеткой.</p>`;
  }

  const items = rows
    .map((row) => {
      const size = eventSize(row.entrantCount);
      const kind = row.state === 'running' || row.state === 'finished' ? EVENT_SIZE_LABELS[size] : 'турнир';
      return `<div class="card">
<div><a href="/t/${row.id}"><strong>${escape(row.name)}</strong></a> <span class="badge">${escape(STATE_LABELS[row.state] ?? row.state)}</span></div>
<div class="dim">${escape(TOURNAMENT_GAME_LABELS[row.game] ?? row.game)} · ${escape(kind)} · участников: ${row.entrantCount}${row.entryMode === 'team' ? ` · по ${row.teamSize} в команде` : ' · одиночки'}</div>
</div>`;
    })
    .join('\n');

  return `<h1>Турниры</h1>\n${items}`;
}

function roundTitle(round: number, rounds: number): string {
  if (round === rounds) return 'Финал';
  if (round === rounds - 1) return 'Полуфинал';
  if (round === rounds - 2) return 'Четвертьфинал';
  return `Круг ${round}`;
}

const MATCH_STATE_LABELS: Record<string, string> = {
  pending: 'ждёт соперников',
  ready: 'можно играть',
  reported: 'результат заявлен, ждём подтверждения',
  confirmed: '',
  disputed: 'результат оспорен, разбирается',
  walkover: 'без игры',
};

export function renderBracket(view: {
  tournament: TournamentRow;
  entrants: EntrantRow[];
  matches: MatchRow[];
}): string {
  const names = new Map<number, string>();
  for (const entrant of view.entrants) names.set(entrant.id, entrant.displayName);

  const active = view.entrants.filter((entrant) => entrant.withdrawnAt === null);
  const size = eventSize(active.length);
  const rounds = view.matches.reduce((max, match) => Math.max(max, match.round), 0);

  const header = `<h1>${escape(view.tournament.name)}</h1>
<p class="dim">${escape(TOURNAMENT_GAME_LABELS[view.tournament.game] ?? view.tournament.game)} · ${escape(EVENT_SIZE_LABELS[size])} · ${escape(STATE_LABELS[view.tournament.state] ?? view.tournament.state)} · участников: ${active.length}</p>`;

  if (view.matches.length === 0) {
    const list = active
      .map((entrant) => `<div class="card">${escape(entrant.displayName)}${entrant.checkedInAt ? ' <span class="badge">отметился</span>' : ''}</div>`)
      .join('\n');
    return `${header}
<h2>Участники</h2>
${list || '<p class="dim">Пока никто не записался.</p>'}`;
  }

  const columns: string[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const cells = view.matches
      .filter((match) => match.round === round)
      .map((match) => {
        const side = (id: number | null): string => {
          if (id === null) return `<div class="side empty"><span>—</span></div>`;
          const won = match.winnerEntrantId === id;
          return `<div class="side${won ? ' won' : ''}"><span>${escape(names.get(id) ?? `#${id}`)}</span><span>${won ? '✓' : ''}</span></div>`;
        };
        const note = MATCH_STATE_LABELS[match.state] ?? '';
        return `<div class="match">${side(match.entrantAId)}${side(match.entrantBId)}${note ? `<div class="state">${escape(note)}</div>` : ''}</div>`;
      })
      .join('\n');
    columns.push(`<div class="round"><h3>${escape(roundTitle(round, rounds))}</h3>${cells}</div>`);
  }

  return `${header}
<h2>Сетка</h2>
<div class="bracket">${columns.join('\n')}</div>`;
}

export interface LeaderboardEntry {
  displayName: string;
  mode: string;
  tier: string | null;
  division: string | null;
  points: number | null;
  score: number;
}

/**
 * Лидерборд показывает **игровой ник и ранг**, но не идентификатор Discord и не имя на
 * сервере. Ранг и ник игрок и так публикует в самой игре, а вот связка «этот Discord —
 * этот игровой аккаунт» приватна: публичная страница не должна становиться способом
 * пробить человека. Поэтому здесь таблица игровых аккаунтов, а не таблица людей.
 */
export function renderLeaderboard(game: TournamentGame, entries: LeaderboardEntry[]): string {
  const label = TOURNAMENT_GAME_LABELS[game] ?? game;

  if (entries.length === 0) {
    return `<h1>${escape(label)}</h1>
<p class="dim">Пока никто не привязал аккаунт этой игры, либо ранги ещё не подтянулись.
Привязка делается командой <code>/link</code> в Discord.</p>`;
  }

  const rows = entries
    .map((entry, index) => {
      const rank = [entry.tier, entry.division].filter(Boolean).join(' ') || 'без ранга';
      const points = entry.points === null ? '' : String(entry.points);
      return `<tr><td class="num">${index + 1}</td><td>${escape(entry.displayName)}</td><td class="dim">${escape(entry.mode)}</td><td>${escape(rank)}</td><td class="num">${escape(points)}</td></tr>`;
    })
    .join('\n');

  return `<h1>${escape(label)}</h1>
<p class="dim">Только подтверждённые привязки. Обновляется автоматически каждые полчаса.</p>
<table>
<thead><tr><th>#</th><th>Аккаунт</th><th>Режим</th><th>Ранг</th><th>Очки</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

export function renderNotFound(what: string): string {
  return `<h1>Не найдено</h1>
<p class="dim">${escape(what)}</p>`;
}
