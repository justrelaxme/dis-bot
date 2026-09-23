import { FONT_FACE } from './font.js';
import { escape, page } from './render.js';

/**
 * Сцены трансляции и пульт к ним.
 *
 * Сцена — окно браузера, которое показывают в Discord через Go Live. Отсюда требования,
 * которых нет у остальной витрины:
 * - кадр ровно 16:9 (1920×1080), который масштабируется под окно целиком, без прокрутки;
 * - всё крупно: Go Live без Nitro — это 720p, и мелкий текст превращается в кашу;
 * - никакого шума и градиентов: они съедают битрейт и мылят картинку;
 * - курсор спрятан, а фон можно сделать прозрачным (`?bg=transparent`) — для OBS поверх игры.
 *
 * Язык тот же, что у витрины: срезанные углы, холодная сталь, акцент дисциплины, цвета сторон
 * драфта. Сцена — часть того же мира, а не чужая заставка.
 *
 * Разметку собирает скрипт на клиенте из `/api/cast/:id`: сцены меняются без перезагрузки
 * окна, а перезагрузка посреди трансляции — это чёрный кадр в эфире.
 */

const CAST_STYLE = `
${FONT_FACE}
:root {
  --ink:#101319; --sheet:#171b23; --sheet-2:#1e232d; --rule:#2b3342; --bone:#e6ebf2; --dim:#8d97a8;
  --ember:#e2543a; --side-a:#f0a93c; --side-b:#59a5d8; --accent:#3fd4e8;
  --display:'Unbounded', ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif;
  --sans: ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif;
  --mono: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  --cut:22px;
  --panel: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
}
* { box-sizing:border-box; }
html, body { margin:0; height:100%; overflow:hidden; background:var(--ink); color:var(--bone); cursor:none; }
body.clear { background:transparent; }
#stage { position:absolute; left:0; top:0; width:1920px; height:1080px; transform-origin:0 0;
  font-family:var(--sans); font-size:34px; line-height:1.2; }
body.clear #stage .fill { background:rgba(16,19,25,.86); }
.top { position:absolute; left:80px; right:80px; top:56px; display:flex; align-items:center; gap:28px; }
.top .game { font-family:var(--mono); font-size:26px; letter-spacing:.24em; text-transform:uppercase; color:var(--accent); }
.top .name { font-family:var(--display); font-size:44px; font-weight:700; letter-spacing:-.01em; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.top .tag { margin-left:auto; font-family:var(--mono); font-size:26px; letter-spacing:.18em; text-transform:uppercase;
  padding:10px 22px; border:3px solid var(--accent); clip-path:var(--panel); }
.top .tag.live { border-color:var(--ember); color:var(--ember); }
.body { position:absolute; left:80px; right:80px; top:170px; bottom:90px; }
.scene { position:absolute; inset:0; animation:enter .45s cubic-bezier(.2,.7,.3,1) both; }
@keyframes enter { from { opacity:0; transform:translateY(24px); } }
.rail { position:absolute; left:80px; right:80px; bottom:52px; height:6px; background:var(--accent); clip-path:polygon(0 0, 100% 0, calc(100% - 6px) 100%, 0 100%); }

/* Скоро начало */
.soon { display:grid; grid-template-columns:1fr 1fr; gap:80px; align-items:center; height:100%; }
.soon .lbl { font-family:var(--mono); font-size:30px; letter-spacing:.24em; text-transform:uppercase; color:var(--dim); }
.soon .clock { font-family:var(--display); font-size:230px; font-weight:800; letter-spacing:-.04em; line-height:1;
  font-variant-numeric:tabular-nums; margin-top:16px; }
.soon .clock.word { font-size:150px; letter-spacing:-.02em; }
.soon .sub { margin-top:24px; font-size:40px; color:var(--dim); }
.soon .sub b { color:var(--bone); }
.names { display:grid; grid-template-columns:1fr 1fr; gap:14px 24px; align-content:center; }
.names span { font-size:36px; padding:14px 24px; background:var(--sheet); clip-path:var(--panel); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; color:var(--dim); }
.names span.in { color:var(--bone); box-shadow:inset 6px 0 0 var(--accent); }

/* Сетка */
.grid { display:flex; gap:44px; height:100%; }
.grid .half { display:flex; gap:44px; flex:1; }
.grid.two { flex-direction:column; gap:26px; }
/* Подпись круга — отдельно от стопки матчей: иначе распределение по высоте уводило бы её вниз
   вместе с матчами, и подписи соседних кругов стояли бы на разной высоте. */
.col { flex:1; display:flex; flex-direction:column; min-width:0; }
.col h3 { margin:0 0 10px; font-family:var(--mono); font-weight:400; font-size:22px; letter-spacing:.22em; text-transform:uppercase; color:var(--dim); }
.stack { flex:1; display:flex; flex-direction:column; justify-content:space-around; gap:14px; }
.box { background:var(--sheet); clip-path:var(--panel); border-left:6px solid var(--rule); }
.box.live { border-left-color:var(--ember); animation:pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { background:var(--sheet-2); } }
.box .ln { display:flex; justify-content:space-between; gap:16px; padding:9px 20px; font-size:30px; white-space:nowrap; }
.box .ln + .ln { border-top:2px solid var(--rule); }
.box .ln span:first-child { overflow:hidden; text-overflow:ellipsis; }
.box .ln.won { color:var(--accent); font-weight:700; }
.box .ln.tbd { color:var(--dim); }
.grid.two .box .ln { font-size:24px; padding:6px 16px; }

/* Драфт */
.draft { display:grid; grid-template-columns:1fr 420px 1fr; gap:48px; height:100%; align-items:start; }
.side h2 { margin:0 0 22px; font-family:var(--display); font-size:58px; font-weight:800; letter-spacing:-.02em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.side.a h2 { color:var(--side-a); }
.side.b h2 { color:var(--side-b); text-align:right; }
.side h4 { margin:26px 0 12px; font-family:var(--mono); font-weight:400; font-size:24px; letter-spacing:.22em; text-transform:uppercase; color:var(--dim); }
.side.b h4 { text-align:right; }
.row { display:flex; flex-wrap:wrap; gap:14px; }
.side.b .row { justify-content:flex-end; }
.pick { width:150px; background:var(--sheet); clip-path:var(--panel); text-align:center; padding-bottom:10px; }
.pick img { display:block; width:150px; height:110px; object-fit:cover; }
.pick span { display:block; font-size:22px; padding:6px 8px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.side.a .pick { box-shadow:inset 0 -6px 0 var(--side-a); }
.side.b .pick { box-shadow:inset 0 -6px 0 var(--side-b); }
.ban { width:118px; background:var(--sheet); clip-path:var(--panel); position:relative; text-align:center; padding-bottom:8px; }
.ban img { display:block; width:118px; height:78px; object-fit:cover; filter:grayscale(1) brightness(.5); }
/* Перечёркнутая иконка — бан читается без подписи, даже если имя героя зритель не помнит. */
.ban::after { content:''; position:absolute; left:-6%; top:34px; width:112%; height:5px; background:var(--ember); transform:rotate(-24deg); }
.ban span { display:block; font-size:19px; padding:6px 6px 0; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.turn { align-self:center; text-align:center; }
.turn .who { font-family:var(--display); font-size:48px; font-weight:800; }
.turn .what { font-family:var(--mono); font-size:30px; letter-spacing:.2em; text-transform:uppercase; color:var(--dim); margin-top:10px; }
.turn .clock { font-family:var(--display); font-size:130px; font-weight:800; font-variant-numeric:tabular-nums; margin-top:18px; }
.turn.a .who { color:var(--side-a); }
.turn.b .who { color:var(--side-b); }

/* Табло матча */
.vs { height:100%; display:grid; grid-template-rows:auto 1fr auto; }
.vs .round { font-family:var(--mono); font-size:30px; letter-spacing:.24em; text-transform:uppercase; color:var(--dim); text-align:center; }
.vs .face { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:60px; }
.vs .team { font-family:var(--display); font-size:92px; font-weight:800; letter-spacing:-.03em; line-height:1.05; overflow-wrap:anywhere; }
.vs .team.a { color:var(--side-a); text-align:right; }
.vs .team.b { color:var(--side-b); }
.vs .seed { display:block; font-family:var(--mono); font-size:26px; letter-spacing:.2em; color:var(--dim); font-weight:400; margin-bottom:8px; }
.vs .score { font-family:var(--display); font-size:170px; font-weight:800; font-variant-numeric:tabular-nums; }
.vs .poll { display:grid; gap:14px; }
.vs .bar { display:flex; height:40px; clip-path:var(--panel); background:var(--sheet); }
.vs .bar i { display:block; height:100%; }
.vs .bar i.a { background:var(--side-a); }
.vs .bar i.b { background:var(--side-b); }
.vs .legend { display:flex; justify-content:space-between; font-size:30px; color:var(--dim); }

/* Пьедестал */
.podium { display:grid; grid-template-columns:1fr 1.25fr 1fr; gap:40px; align-items:end; height:100%; }
.podium.duo { grid-template-columns:1fr 1.25fr; padding:0 12%; }
/* Ступени пьедестала по высоте: чемпион выше всех, как на настоящем. */
.step { background:var(--sheet); clip-path:var(--panel); padding:40px 36px; text-align:center; }
.step .place { font-family:var(--mono); font-size:30px; letter-spacing:.24em; text-transform:uppercase; color:var(--dim); }
.step .who { font-family:var(--display); font-weight:800; font-size:60px; margin-top:16px; overflow-wrap:anywhere; }
.step.first { height:88%; box-shadow:inset 0 8px 0 var(--accent); }
.step.first .who { font-size:92px; color:var(--accent); }
.step.second { height:68%; }
.step.third { height:54%; }

.empty { height:100%; display:grid; place-items:center; font-family:var(--display); font-size:64px; color:var(--dim); }
@media (prefers-reduced-motion:reduce) { .scene, .box.live { animation:none; } }
`;

/**
 * Скрипт сцены. Внутри нет обратных кавычек и подстановок: он сам лежит в шаблонной строке, и
 * они бы её закрыли. Экранирование — вручную, esc() на всё, что пришло из базы.
 */
const CAST_SCRIPT = `
(function () {
  var ID = document.body.getAttribute('data-tournament');
  var stage = document.getElementById('stage');
  var data = null, offset = 0, live = false;
  var params = new URLSearchParams(location.search);
  if (params.get('bg') === 'transparent') document.body.classList.add('clear');
  // Сцена, закреплённая в адресе, — для отдельного источника OBS, который не переключается.
  var pinned = params.get('scene') ? '?scene=' + encodeURIComponent(params.get('scene')) : '';

  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = ((window.innerWidth - 1920 * s) / 2) + 'px';
    stage.style.top = ((window.innerHeight - 1080 * s) / 2) + 'px';
  }
  window.addEventListener('resize', fit);
  fit();

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function now() { return Date.now() + offset; }
  function clock(iso) {
    if (!iso) return '—';
    var left = Math.max(0, Math.round((Date.parse(iso) - now()) / 1000));
    var m = Math.floor(left / 60), s = left % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function seconds(iso) {
    if (!iso) return '';
    return Math.max(0, Math.round((Date.parse(iso) - now()) / 1000)) + '';
  }

  function soon() {
    var t = data.entrants, checked = t.filter(function (e) { return e.checkedIn; }).length;
    // Без назначенного времени — слово, а не прочерк: прочерк на такой высоте читается полосой.
    var big = data.countdownAt
      ? '<div class="clock" data-clock="' + esc(data.countdownAt) + '">' + clock(data.countdownAt) + '</div>'
      : '<div class="clock word">Скоро</div>';
    return '<div class="scene soon"><div><div class="lbl">' + (data.countdownAt ? 'До начала' : 'Начинаем') + '</div>' + big +
      '<div class="sub">Отметились <b>' + checked + '</b> из ' + t.length + '</div></div>' +
      '<div class="names">' + t.slice(0, 16).map(function (e) { return '<span class="' + (e.checkedIn ? 'in' : '') + '">' + esc(e.name) + '</span>'; }).join('') + '</div></div>';
  }

  function box(m) {
    function ln(name, side, score) {
      var cls = name == null ? 'tbd' : (m.winner === side ? 'won' : '');
      var tail = score != null ? score : (m.winner === side ? '✓' : '');
      return '<div class="ln ' + cls + '"><span>' + esc(name == null ? '—' : name) + '</span><span>' + esc(tail) + '</span></div>';
    }
    return '<div class="box' + (m.live ? ' live' : '') + '">' + ln(m.a, 'a', m.scoreA) + ln(m.b, 'b', m.scoreB) + '</div>';
  }
  function columns(cols, title) {
    return cols.map(function (col, i) {
      return '<div class="col"><h3>' + esc(title(i, cols.length)) + '</h3><div class="stack">' + col.map(box).join('') + '</div></div>';
    }).join('');
  }
  function bracket() {
    var b = data.bracket, two = b.lower.length > 0;
    var upperTitle = function (i, n) { return i === n - 1 ? (two ? 'Финал верха' : 'Финал') : i === n - 2 ? 'Полуфинал' : 'Круг ' + (i + 1); };
    var lowerTitle = function (i, n) { return i === n - 1 ? 'Финал низа' : 'Низ · круг ' + (i + 1); };
    var grand = b.grand ? '<div class="col"><h3>Гранд-финал</h3><div class="stack">' + box(b.grand) + '</div></div>' : '';
    if (!two) return '<div class="scene grid">' + columns(b.upper, upperTitle) + grand + '</div>';
    return '<div class="scene grid two"><div class="half">' + columns(b.upper, upperTitle) + grand + '</div><div class="half">' + columns(b.lower, lowerTitle) + '</div></div>';
  }

  function picks(list, cls) {
    if (!list.length) return '<div class="row"></div>';
    return '<div class="row">' + list.map(function (p) {
      var img = p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="">' : '';
      return '<div class="' + cls + '">' + img + '<span>' + esc(p.label) + '</span></div>';
    }).join('') + '</div>';
  }
  function draft() {
    var f = data.featured, d = data.draft;
    if (!f || !d) return '<div class="scene empty">Драфт ещё не начался</div>';
    var turn;
    if (d.done) turn = '<div class="turn"><div class="what">Драфт закончен</div></div>';
    else if (!d.armed) turn = '<div class="turn"><div class="what">Ждём, пока обе стороны на месте</div></div>';
    else if (d.current) {
      var who = d.current.side === 'a' ? f.a.name : f.b.name;
      turn = '<div class="turn ' + d.current.side + '"><div class="who">' + esc(who) + '</div><div class="what">' + (d.current.kind === 'ban' ? 'банит' : 'выбирает') + '</div>' +
        '<div class="clock" data-seconds="' + esc(d.deadlineAt || '') + '">' + seconds(d.deadlineAt) + '</div></div>';
    } else turn = '<div class="turn"></div>';
    function side(key, team) {
      return '<div class="side ' + key + '"><h2>' + esc(team.name) + '</h2><h4>Баны</h4>' + picks(d.bans[key], 'ban') + '<h4>Пики</h4>' + picks(d.picks[key], 'pick') + '</div>';
    }
    return '<div class="scene draft">' + side('a', f.a) + turn + side('b', f.b) + '</div>';
  }

  function match() {
    var f = data.featured;
    if (!f) return '<div class="scene empty">Матча пока нет</div>';
    var score = (f.a.score != null && f.b.score != null) ? f.a.score + ' : ' + f.b.score : 'VS';
    var total = f.votes.a + f.votes.b;
    var pa = total ? Math.round(f.votes.a / total * 100) : 50;
    var poll = total
      ? '<div class="poll"><div class="bar"><i class="a" style="width:' + pa + '%"></i><i class="b" style="width:' + (100 - pa) + '%"></i></div>' +
        '<div class="legend"><span>' + pa + '% за ' + esc(f.a.name) + '</span><span>' + total + ' прогнозов</span><span>' + (100 - pa) + '% за ' + esc(f.b.name) + '</span></div></div>'
      : '<div class="poll"><div class="legend"><span></span><span>Прогнозы — кнопками в ветке «Прогнозы» в Discord</span><span></span></div></div>';
    function seed(s) { return s != null ? '<span class="seed">сид ' + s + '</span>' : ''; }
    return '<div class="scene vs"><div class="round">' + esc(f.label) + ' · матч ' + f.id + '</div>' +
      '<div class="face"><div class="team a">' + seed(f.a.seed) + esc(f.a.name) + '</div><div class="score">' + esc(score) + '</div><div class="team b">' + seed(f.b.seed) + esc(f.b.name) + '</div></div>' + poll + '</div>';
  }

  function podium() {
    var p = data.podium;
    if (!p) return '<div class="scene empty">Турнир ещё идёт</div>';
    function step(cls, place, who) { return '<div class="step ' + cls + '"><div class="place">' + place + '</div><div class="who">' + esc(who || '—') + '</div></div>'; }
    // Третьего места при выбывании нет — полуфиналисты друг с другом не играли, и пустая
    // ступень с прочерком выглядела бы недоделкой.
    if (!p.third) return '<div class="scene podium duo">' + step('second', '2 место', p.second) + step('first', 'Чемпион', p.first) + '</div>';
    return '<div class="scene podium">' + step('second', '2 место', p.second) + step('first', 'Чемпион', p.first) + step('third', '3 место', p.third) + '</div>';
  }

  var SCENES = { soon: soon, bracket: bracket, draft: draft, match: match, podium: podium };
  var TAGS = { soon: 'Скоро', bracket: 'Сетка', draft: 'Драфт', match: 'Матч', podium: 'Итог' };
  var shown = '';

  function render() {
    if (!data) return;
    document.documentElement.style.setProperty('--accent', data.tournament.accent);
    var isLive = data.featured && data.featured.live && data.scene !== 'podium';
    var html = '<div class="top"><span class="game">' + esc(data.tournament.gameLabel) + '</span><span class="name">' + esc(data.tournament.name) + '</span>' +
      '<span class="tag' + (isLive ? ' live' : '') + '">' + (isLive ? '● В эфире' : TAGS[data.scene]) + '</span></div>' +
      '<div class="body">' + SCENES[data.scene]() + '</div><div class="rail"></div>';
    // Перерисовка только при изменении: иначе каждое обновление заново проигрывало бы появление.
    if (html !== shown) { stage.innerHTML = html; shown = html; }
  }

  function tick() {
    Array.prototype.forEach.call(stage.querySelectorAll('[data-clock]'), function (el) { el.textContent = clock(el.getAttribute('data-clock')); });
    Array.prototype.forEach.call(stage.querySelectorAll('[data-seconds]'), function (el) { el.textContent = seconds(el.getAttribute('data-seconds')); });
  }

  function load() {
    fetch('/api/cast/' + ID + pinned, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { if (!p) return; offset = Date.parse(p.now) - Date.now(); data = p; render(); tick(); })
      .catch(function () {});
  }

  if ('EventSource' in window) {
    var opened = false;
    var source = new EventSource('/api/live/t/' + ID);
    source.addEventListener('change', load);
    source.addEventListener('open', function () { live = true; if (opened) load(); opened = true; });
    source.addEventListener('error', function () { live = false; });
  }
  load();
  setInterval(tick, 250);
  // Запасной путь: поток мог оборваться, а сцена в эфире не должна застывать.
  setInterval(function () { if (!live) load(); }, 5000);
  setInterval(load, 60000);
})();
`;

export function castPage(input: { tournamentId: number; title: string }): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Трансляция — ${escape(input.title)}</title>
<style>${CAST_STYLE}</style>
</head>
<body data-tournament="${input.tournamentId}">
<div id="stage"></div>
<script>${CAST_SCRIPT}</script>
</body>
</html>`;
}

const CONTROL_STYLE = `
.cast-ctl { display:grid; gap:1.2rem; max-width:34rem; }
.cast-ctl section { background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel); padding:.9rem 1rem; }
.cast-ctl h2 { margin:0 0 .6rem; font-family:var(--mono); font-size:.72rem; letter-spacing:.16em; text-transform:uppercase; color:var(--dim); font-weight:400; }
.cast-ctl .scenes { display:grid; grid-template-columns:repeat(3,1fr); gap:.5rem; }
.cast-ctl button, .cast-ctl select, .cast-ctl input { font:inherit; font-family:var(--mono); font-size:.85rem; }
.cast-ctl button { padding:.7rem .5rem; background:var(--sheet-2); color:var(--bone); border:1px solid var(--rule);
  clip-path:var(--panel); cursor:pointer; transition:border-color .16s, transform .16s var(--ease); }
.cast-ctl button:active { transform:translateY(1px); }
.cast-ctl button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
.cast-ctl button:focus-visible, .cast-ctl select:focus-visible, .cast-ctl input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.cast-ctl select, .cast-ctl input { width:100%; padding:.6rem; background:var(--ink-2); color:var(--bone); border:1px solid var(--rule); }
.cast-ctl .inline { display:flex; gap:.5rem; }
.cast-ctl .said { min-height:1.2rem; font-family:var(--mono); font-size:.8rem; color:var(--dim); }
.cast-ctl .said[data-kind="err"] { color:var(--ember); }
.cast-ctl ol { margin:.2rem 0 0; padding-left:1.2rem; color:var(--dim); font-size:.9rem; }
.cast-ctl code { font-size:.8rem; }
`;

export function castControlPage(input: { token: string; tournamentId: number | null; title: string }): string {
  if (input.tournamentId === null) {
    return page('Пульт трансляции', '<h1>Пульт трансляции</h1><p class="lede">На сервере пока нет турнира — показывать нечего.</p>');
  }
  const overlay = `/cast/t/${input.tournamentId}`;
  const body = `<p class="eyebrow">${escape(input.title)}</p>
<h1>Пульт трансляции</h1>
<p class="lede">Сцена сама выбирает, что показать: до старта — отсчёт, во время драфта — драфт, в матче — табло, между матчами — сетку, после финала — пьедестал. Здесь это можно переопределить.</p>
<div class="cast-ctl" data-token="${escape(input.token)}" data-tournament="${input.tournamentId}">
  <section>
    <h2>Сцена</h2>
    <div class="scenes">
      <button data-scene="auto">Сама</button><button data-scene="soon">Скоро</button><button data-scene="bracket">Сетка</button>
      <button data-scene="draft">Драфт</button><button data-scene="match">Матч</button><button data-scene="podium">Итог</button>
    </div>
  </section>
  <section>
    <h2>Матч на табло</h2>
    <select id="featured"><option value="">Сам — самый поздний идущий</option></select>
  </section>
  <section>
    <h2>Отсчёт «скоро начало»</h2>
    <div class="inline"><input id="minutes" type="number" min="1" max="180" placeholder="минут"><button id="count">Поставить</button><button id="nocount">Время старта</button></div>
  </section>
  <p class="said" id="said"></p>
  <section>
    <h2>Как вывести в Discord</h2>
    <ol>
      <li>Откройте сцену в отдельном окне: <a href="${overlay}" target="_blank" rel="noopener">${overlay}</a>. Лучше всего — в Chrome с флагом <code>--app=адрес</code>, без вкладок и адресной строки.</li>
      <li>В голосовом канале — «Демонстрация экрана» → это окно.</li>
      <li>Поверх игры — через OBS: источник «Браузер» с адресом <code>${overlay}?bg=transparent</code>, и в Discord показываете окно проектора OBS.</li>
      <li>Сцену можно закрепить в адресе, и пульт её не переключит: <code>${overlay}?scene=bracket</code> — всегда сетка.</li>
    </ol>
  </section>
</div>
<script>
(function () {
  var root = document.querySelector('.cast-ctl');
  var token = root.getAttribute('data-token'), id = root.getAttribute('data-tournament');
  var said = document.getElementById('said'), select = document.getElementById('featured');
  function say(text, kind) { said.textContent = text || ''; said.setAttribute('data-kind', kind || ''); }
  function show(p) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-scene]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-scene') === p.requested ? 'true' : 'false'); });
    var boxes = [].concat.apply([], p.bracket.upper.concat(p.bracket.lower)).concat(p.bracket.grand ? [p.bracket.grand] : []);
    var keep = select.value;
    select.innerHTML = '<option value="">Сам — самый поздний идущий</option>' + boxes
      .filter(function (m) { return m.a && m.b && !m.winner; })
      .map(function (m) { return '<option value="' + m.id + '">№' + m.id + ' · ' + m.a.replace(/</g, '&lt;') + ' — ' + m.b.replace(/</g, '&lt;') + '</option>'; })
      .join('');
    select.value = keep;
    say('Сейчас на сцене: ' + ({ soon: 'скоро начало', bracket: 'сетка', draft: 'драфт', match: 'табло матча', podium: 'пьедестал' })[p.scene] + (p.featured ? ' · матч №' + p.featured.id : ''));
  }
  function send(body) {
    fetch('/api/cast/' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (!x.ok) { say(x.j.error || 'Не принято.', 'err'); return; } show(x.j); })
      .catch(function () { say('Не дошло до сервера — попробуйте ещё раз.', 'err'); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-scene]'), function (b) {
    b.addEventListener('click', function () { send({ scene: b.getAttribute('data-scene') }); });
  });
  select.addEventListener('change', function () { send({ featuredMatchId: select.value ? Number(select.value) : null }); });
  document.getElementById('count').addEventListener('click', function () { send({ countdownMinutes: Number(document.getElementById('minutes').value) }); });
  document.getElementById('nocount').addEventListener('click', function () { send({ countdownMinutes: 0 }); });
  fetch('/api/cast/' + id, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(show).catch(function () {});
})();
</script>`;
  return page('Пульт трансляции', body, { head: `<style>${CONTROL_STYLE}</style>`, description: 'Пульт сцен трансляции турнира.' });
}
