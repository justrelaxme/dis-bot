import { escape } from './render.js';

/**
 * Страница драфта. Единственная страница витрины, где что-то нажимают, — поэтому здесь
 * единственный скрипт в проекте.
 *
 * Разметку рисует браузер из состояния, а не сервер: иначе одна и та же логика отрисовки
 * жила бы в двух местах, на сервере и в опросе, и однажды они показали бы разное. Сервер
 * отдаёт первое состояние прямо в странице — чтобы первый кадр был сразу, без пустоты.
 *
 * Опрос, а не веб-сокеты: драфт живёт минуты, участников двое плюс зрители, а сокет — это
 * отдельное соединение, отдельные обрывы и отдельный способ сломаться. Раз в две секунды
 * достаточно, чтобы ход соперника выглядел мгновенным.
 *
 * Таймер в браузере — подсказка. Решает всё равно сервер: он ставит дедлайн и он же двигает
 * просроченный ход джобой. Расхождение часов клиента ни на что не влияет.
 */

export const DRAFT_STYLE = `
.dhead { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:1.25rem; }
.vs { display:flex; align-items:center; gap:.9rem; font-size:clamp(1.1rem,3.4vw,1.6rem); font-weight:800;
  letter-spacing:-.02em; }
.vs .mid { font-family:var(--mono); font-size:.7rem; letter-spacing:.2em; color:var(--dim); }
.side-a, .side-b { padding:.15rem .5rem; border-radius:3px; border:1px solid var(--rule); }
.side-a.act { border-color:var(--gold); color:var(--gold); }
.side-b.act { border-color:var(--gold); color:var(--gold); }

.turn { font-family:var(--mono); font-size:.8rem; letter-spacing:.08em; padding:.45rem .7rem;
  border:1px solid var(--rule); border-radius:3px; display:inline-flex; gap:.6rem; align-items:center; }
.turn.mine { border-color:var(--gold); color:var(--gold); }
.turn.over { border-color:var(--ember); color:var(--ember); }
.clock { font-variant-numeric:tabular-nums; }

.bar { height:3px; background:var(--rule); border-radius:2px; overflow:hidden; margin:1rem 0 1.5rem; }
.bar i { display:block; height:100%; background:var(--gold); transition:width .3s ease; }

.pool { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fill,minmax(104px,1fr)); }
.opt { position:relative; background:var(--sheet); border:1px solid var(--rule); border-radius:3px;
  padding:.4rem; cursor:pointer; text-align:center; font-size:.76rem; line-height:1.25;
  transition:border-color .15s, transform .15s, opacity .15s; }
.opt img { width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:2px; display:block;
  margin-bottom:.35rem; background:var(--sheet-2); }
.opt.maps img { aspect-ratio:4/3; }
.opt:hover:not([disabled]) { border-color:var(--gold); transform:translateY(-2px); }
.opt[disabled] { cursor:default; opacity:.42; }
.pool.idle .opt { cursor:default; }

.taken { display:flex; flex-wrap:wrap; gap:.4rem; margin:.35rem 0 0; }
.chip-ban, .chip-pick { font-family:var(--mono); font-size:.72rem; padding:.2rem .45rem; border-radius:2px;
  border:1px solid var(--rule); }
.chip-ban { color:var(--dim); text-decoration:line-through; }
.chip-pick { color:var(--bone); border-color:rgba(217,165,68,.45); }

.result { display:flex; flex-wrap:wrap; gap:.6rem; margin-top:.6rem; }
.result .r { font-weight:700; color:var(--gold); border:1px solid var(--gold); border-radius:3px;
  padding:.35rem .7rem; }

.filter { width:100%; max-width:22rem; background:var(--sheet); color:var(--bone); font-family:var(--mono);
  font-size:.85rem; border:1px solid var(--rule); border-radius:3px; padding:.5rem .7rem; margin-bottom:.9rem; }
.filter:focus { outline:none; border-color:var(--gold); }

.note { color:var(--dim); font-size:.85rem; margin:.5rem 0 0; }
.err { color:var(--ember); font-family:var(--mono); font-size:.8rem; min-height:1.2em; margin:.6rem 0 0; }
.skip { background:none; border:1px solid var(--rule); color:var(--dim); font-family:var(--mono);
  font-size:.76rem; border-radius:3px; padding:.4rem .7rem; cursor:pointer; }
.skip:hover:not([disabled]) { border-color:var(--bone); color:var(--bone); }
.skip[disabled] { opacity:.4; cursor:default; }
`;

/**
 * Начальное состояние встраивается в страницу, а не запрашивается вторым запросом: иначе
 * первый кадр был бы пустым. `<` экранируется — иначе строка вида `</script>` внутри данных
 * закрыла бы тег и превратила данные в разметку.
 */
function inlineState(state: unknown): string {
  return JSON.stringify(state).replaceAll('<', '\\u003c');
}

export function draftShell(state: { tournamentName: string; subject: 'heroes' | 'maps' }): string {
  const isHeroes = state.subject === 'heroes';

  return `<h1>Драфт</h1>
<p class="lede">${escape(state.tournamentName)} — ${isHeroes ? 'баны и пики героев' : 'вето карт'}.
${
  isHeroes
    ? 'Результат нужно воспроизвести в лобби: клиент об этой странице не знает, зато спорить о том, кто что банил, больше не о чем.'
    : 'Оставшаяся карта — решающая: её никто не выбирал.'
}</p>

<div class="dhead">
  <div class="vs"><span class="side-a" id="nameA">—</span><span class="mid">против</span><span class="side-b" id="nameB">—</span></div>
  <span class="turn" id="turn">загрузка…</span>
  <button class="skip" id="skip" hidden>Пропустить бан</button>
</div>

<div class="bar"><i id="bar" style="width:0%"></i></div>
<p class="err" id="err"></p>

<h2 id="poolTitle">Доступно</h2>
${isHeroes ? '<input class="filter" id="filter" placeholder="Поиск героя" autocomplete="off">' : ''}
<div class="pool" id="pool"></div>

<h2>Забанено</h2>
<div class="taken" id="banned"></div>

<h2>Выбрано</h2>
<div class="taken" id="picks"></div>

<div id="resultBlock" hidden>
  <h2>Итог</h2>
  <div class="result" id="result"></div>
  <p class="note" id="resultNote"></p>
</div>

<script>
(function () {
  var state = ${inlineState(state)};
  var token = new URLSearchParams(location.search).get('as') || '';
  var subject = state.subject;
  var filterText = '';

  var el = function (id) { return document.getElementById(id); };
  var esc = function (value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };

  function optionCard(option, disabled) {
    var img = option.imageUrl ? '<img src="' + esc(option.imageUrl) + '" alt="" loading="lazy">' : '';
    return '<button class="opt ' + subject + '" data-id="' + esc(option.id) + '"' +
      (disabled ? ' disabled' : '') + '>' + img + esc(option.label) + '</button>';
  }

  function myTurn() {
    return !state.done && state.you && state.current && state.current.side === state.you;
  }

  function render() {
    el('nameA').textContent = state.teams.a;
    el('nameB').textContent = state.teams.b;
    el('nameA').className = 'side-a' + (state.current && state.current.side === 'a' ? ' act' : '');
    el('nameB').className = 'side-b' + (state.current && state.current.side === 'b' ? ' act' : '');

    var turn = el('turn');
    if (state.done) {
      turn.className = 'turn';
      turn.textContent = 'Драфт закончен';
    } else if (!state.current) {
      turn.className = 'turn';
      turn.textContent = 'Ожидание';
    } else {
      var who = state.current.side === 'a' ? state.teams.a : state.teams.b;
      var what = state.current.kind === 'ban' ? 'банит' : 'выбирает';
      turn.className = 'turn' + (myTurn() ? ' mine' : '');
      turn.innerHTML = esc((myTurn() ? 'Твой ход: ' : who + ' ') + what) +
        '<span class="clock" id="clock"></span>';
    }

    el('bar').style.width = state.total ? Math.round((state.step / state.total) * 100) + '%' : '0%';

    var skip = el('skip');
    var canSkip = myTurn() && state.current.kind === 'ban';
    skip.hidden = !canSkip;
    skip.disabled = !canSkip;

    var visible = state.available.filter(function (option) {
      return !filterText || option.label.toLowerCase().indexOf(filterText) >= 0;
    });
    el('poolTitle').textContent = 'Доступно — ' + state.available.length;
    el('pool').className = 'pool' + (myTurn() ? '' : ' idle');
    el('pool').innerHTML = visible.map(function (option) {
      return optionCard(option, !myTurn());
    }).join('');

    el('banned').innerHTML = state.banned.length
      ? state.banned.map(function (o) { return '<span class="chip-ban">' + esc(o.label) + '</span>'; }).join('')
      : '<span class="chip-ban" style="text-decoration:none">пока никого</span>';

    var picks = [];
    state.picks.a.forEach(function (o) { picks.push('<span class="chip-pick">' + esc(state.teams.a) + ': ' + esc(o.label) + '</span>'); });
    state.picks.b.forEach(function (o) { picks.push('<span class="chip-pick">' + esc(state.teams.b) + ': ' + esc(o.label) + '</span>'); });
    el('picks').innerHTML = picks.length ? picks.join('') : '<span class="chip-ban" style="text-decoration:none">пока ничего</span>';

    el('resultBlock').hidden = !state.done;
    if (state.done) {
      el('result').innerHTML = state.result.map(function (o) { return '<span class="r">' + esc(o.label) + '</span>'; }).join('');
      el('resultNote').textContent = subject === 'maps'
        ? 'Играете на этом. Оставшаяся карта не выбиралась никем — она решающая.'
        : 'Воспроизведите это в лобби: забаненных героев не берёт никто, выбранных берёт своя команда.';
    }

    tick();
  }

  function tick() {
    var clock = el('clock');
    if (!clock) return;
    if (!state.deadlineAt) { clock.textContent = ''; return; }
    var left = Math.max(0, Math.round((new Date(state.deadlineAt).getTime() - Date.now()) / 1000));
    clock.textContent = left + ' с';
    el('turn').classList.toggle('over', left === 0);
  }

  function apply(next) { state = next; render(); }

  function say(message) { el('err').textContent = message || ''; }

  async function refresh() {
    try {
      var response = await fetch('/api/draft/' + state.matchId + (token ? '?as=' + encodeURIComponent(token) : ''), { cache: 'no-store' });
      if (response.ok) apply(await response.json());
    } catch (error) {
      // Разрыв связи — не повод ломать страницу: следующий опрос через две секунды.
    }
  }

  async function choose(optionId) {
    say('');
    try {
      var response = await fetch('/api/draft/' + state.matchId + '/choose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token, optionId: optionId }),
      });
      var body = await response.json();
      if (!response.ok) { say(body.error || 'Ход не принят.'); await refresh(); return; }
      apply(body);
    } catch (error) {
      say('Не дошло до сервера — попробуй ещё раз.');
    }
  }

  el('pool').addEventListener('click', function (event) {
    var button = event.target.closest('.opt');
    if (!button || button.disabled) return;
    choose(button.dataset.id);
  });

  el('skip').addEventListener('click', function () { choose(null); });

  var filter = el('filter');
  if (filter) {
    filter.addEventListener('input', function () {
      filterText = filter.value.trim().toLowerCase();
      render();
    });
  }

  render();
  setInterval(tick, 1000);
  // Опрос продолжается и после конца драфта, но реже: страница остаётся протоколом, и
  // зритель, открывший её позже, должен увидеть итог без перезагрузки.
  setInterval(function () { if (!state.done) refresh(); }, 2000);
  setInterval(function () { if (state.done) refresh(); }, 30000);
})();
</script>`;
}
