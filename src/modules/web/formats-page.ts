import { escape } from './render.js';

/**
 * Конструктор форматов турнира: страница, на которой формат собирают из кирпичиков.
 *
 * Почему на сайте, а не в командах Discord. Настроек одиннадцать, и слэш-команда с
 * одиннадцатью опциями — это список, в котором не видно ни того, что уже выбрано, ни того,
 * что получится. Собирать формат так можно, а вот **менять** его почти нельзя: чтобы
 * поправить одну настройку, приходится вспомнить и перевбить остальные. Страница держит всё
 * перед глазами, и правка одного кирпичика остаётся правкой одного кирпичика.
 *
 * Предпросмотр приходит с сервера, а не считается здесь. Это главное решение страницы:
 * «сетка на выбывание, до трёх волн, драфт персонажей» считают те же функции, что строят
 * настоящий турнир. Своя копия расчёта на странице разошлась бы с ботом на первой же правке
 * — и обещание «вот что получится» перестало бы им быть, причём молча.
 *
 * Право менять даёт токен в адресе, а не вход на сайт: витрина анонимна по устройству, и
 * второй способ доказать, кто ты, означал бы второй список людей. Устройство пропуска и его
 * цена описаны в `schema.ts`.
 */

export const FORMATS_STYLE = `
.builder { display:grid; gap:1.4rem; align-items:start; }
@media (min-width:900px) { .builder { grid-template-columns:minmax(0,1fr) 20rem; } }

.bricks { display:grid; gap:1rem; }
.brick { background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel); padding:.9rem 1rem 1rem;
  animation:enter .4s var(--ease) both; animation-delay:var(--delay,0ms); }
.brick > h2 { font-family:var(--mono); font-size:.68rem; letter-spacing:.2em; text-transform:uppercase;
  color:var(--dim); margin:0 0 .1rem; font-weight:400; }
.brick > p.hint { color:var(--dim); font-size:.8rem; margin:.2rem 0 .7rem; }

/* Кирпичик выбора: вариант либо взят, либо нет. Ничего похожего на «немного выбран» здесь
   быть не должно — от этих переключателей зависит турнир, и полутон читался бы как сбой. */
.opts { display:flex; flex-wrap:wrap; gap:.4rem; }
.opt { font-family:var(--mono); font-size:.78rem; padding:.42rem .7rem; color:var(--dim);
  background:var(--sheet-2); border:1px solid var(--rule); clip-path:var(--panel);
  cursor:pointer; transition:color .18s, border-color .18s, transform .18s var(--ease); }
.opt:hover { color:var(--bone); }
.opt:active { transform:translateY(1px); }
.opt[aria-pressed="true"] { color:var(--ink); background:var(--accent); border-color:var(--accent); }
.opt:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

.nums { display:flex; flex-wrap:wrap; gap:1rem; }
.num { display:grid; gap:.3rem; }
.num > span { font-family:var(--mono); font-size:.68rem; letter-spacing:.14em; text-transform:uppercase;
  color:var(--dim); }
.num input { width:6.5rem; background:var(--ink-2); color:var(--bone); border:1px solid var(--rule);
  padding:.42rem .6rem; font-family:var(--mono); font-size:.9rem; }
.num input:focus { outline:none; border-color:var(--accent); }
.num input:disabled { color:var(--dim); }

.toggles { display:grid; gap:.5rem; }
.tog { display:flex; gap:.7rem; align-items:flex-start; text-align:left; width:100%;
  background:none; border:none; padding:.2rem 0; color:inherit; font:inherit; cursor:pointer; }
.tog .box { flex:0 0 auto; width:1.05rem; height:1.05rem; margin-top:.15rem; background:var(--ink-2);
  border:1px solid var(--rule); position:relative; transition:background .18s, border-color .18s; }
.tog[aria-pressed="true"] .box { background:var(--accent); border-color:var(--accent); }
.tog[aria-pressed="true"] .box::after { content:''; position:absolute; inset:22%;
  border:2px solid var(--ink); border-top:none; border-right:none; rotate:-45deg; translate:0 -12%; }
.tog .txt { display:grid; gap:.1rem; }
.tog .txt b { font-weight:500; font-size:.9rem; }
.tog .txt em { font-style:normal; color:var(--dim); font-size:.78rem; }
.tog:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }

.namebox { display:grid; gap:.6rem; }
.namebox input, .namebox textarea { background:var(--ink-2); color:var(--bone);
  border:1px solid var(--rule); padding:.5rem .7rem; font-family:inherit; font-size:.92rem; width:100%; }
.namebox textarea { min-height:3.4rem; resize:vertical; }
.namebox input:focus, .namebox textarea:focus { outline:none; border-color:var(--accent); }

/* Предпросмотр прилипает: кирпичики листают, а «что получится» должно оставаться на виду —
   иначе решение принимают по памяти, а не по тому, что написано. */
.side { display:grid; gap:1rem; }
@media (min-width:900px) { .side { position:sticky; top:1.2rem; } }
.preview { background:var(--sheet); border:1px solid var(--accent); clip-path:var(--panel); padding:1rem; }
.preview h2 { font-family:var(--display); font-size:1.02rem; line-height:1.2; margin:0 0 .6rem; }
.preview ul { list-style:none; padding:0; margin:0; display:grid; gap:.34rem; }
.preview li { font-size:.84rem; color:var(--bone); padding-left:.8rem; position:relative; }
.preview li::before { content:''; position:absolute; left:0; top:.52em; width:4px; height:1px;
  background:var(--accent); }
.preview .warn { margin-top:.7rem; display:grid; gap:.34rem; }
.preview .warn li::before { background:var(--ember); }
.preview .warn li { color:var(--dim); }
.preview[data-busy="1"] { opacity:.55; }

.act { display:flex; flex-wrap:wrap; gap:.5rem; }
.btn { font-family:var(--mono); font-size:.8rem; letter-spacing:.06em; padding:.55rem .9rem;
  background:var(--accent); color:var(--ink); border:1px solid var(--accent); clip-path:var(--panel);
  cursor:pointer; transition:transform .16s var(--ease), opacity .16s; }
.btn:active { transform:translateY(1px); }
.btn[disabled] { opacity:.5; cursor:default; }
.btn.ghost { background:none; color:var(--dim); border-color:var(--rule); }
.btn.ghost:hover { color:var(--bone); border-color:var(--accent); }
.btn:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }

.said { font-family:var(--mono); font-size:.76rem; min-height:1.1rem; color:var(--dim); }
.said[data-kind="ok"] { color:var(--accent); }
.said[data-kind="err"] { color:var(--ember); }

.saved { display:grid; gap:.6rem; margin-top:2rem; }
.preset { background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel);
  padding:.8rem .9rem; display:grid; gap:.4rem; }
.preset[data-open="1"] { border-color:var(--accent); }
.preset .row { display:flex; gap:.6rem; align-items:baseline; flex-wrap:wrap; }
.preset .nm { font-family:var(--display); font-size:1rem; }
.preset .meta { font-family:var(--mono); font-size:.72rem; color:var(--dim); }
.preset .sum { font-size:.82rem; color:var(--dim); }
.preset .cmd { font-family:var(--mono); font-size:.72rem; color:var(--bone);
  background:var(--ink-2); border:1px solid var(--rule); padding:.3rem .5rem; overflow-x:auto; }
.preset .act { margin-top:.2rem; }
.saved > div > .sum { color:var(--dim); font-size:.85rem; }

/* Всё, что появляется движением, обязано просто быть. Список в theme.ts про классы этой
   страницы не знает, поэтому она отвечает за свои сама. */
@media (prefers-reduced-motion:reduce) {
  .brick, .preset { animation:none; opacity:1; transform:none; }
}
`;

export interface FormatCard {
  id: number;
  name: string;
  summary: string;
  note: string | null;
  usedCount: number;
  /** Настройки как есть: страница подставляет их в конструктор при «Открыть». */
  bricks: Record<string, unknown>;
}

export interface FormatsShellState {
  token: string;
  guildName: string;
  games: { value: string; label: string }[];
  cards: FormatCard[];
  limit: number;
}

function opts(key: string, items: { value: string; label: string }[]): string {
  return `<div class="opts" data-group="${escape(key)}">${items
    .map(
      (item) =>
        `<button type="button" class="opt" data-k="${escape(key)}" data-v="${escape(item.value)}" aria-pressed="false">${escape(item.label)}</button>`,
    )
    .join('')}</div>`;
}

function toggle(key: string, title: string, hint: string): string {
  return `<button type="button" class="tog" data-t="${escape(key)}" aria-pressed="false">
<span class="box" aria-hidden="true"></span>
<span class="txt"><b>${escape(title)}</b><em>${escape(hint)}</em></span>
</button>`;
}

function cardHtml(card: FormatCard): string {
  return `<article class="preset" data-id="${card.id}">
<div class="row"><span class="nm">${escape(card.name)}</span>
<span class="meta">${card.usedCount === 0 ? 'ещё не запускали' : `запусков ${card.usedCount}`}</span></div>
<p class="sum">${escape(card.summary)}</p>
${card.note ? `<p class="sum">${escape(card.note)}</p>` : ''}
<p class="cmd">/tournament create preset:${escape(card.name)}</p>
<div class="act">
<button type="button" class="btn ghost" data-open="${card.id}">Открыть в конструкторе</button>
<button type="button" class="btn ghost" data-del="${card.id}">Удалить</button>
</div>
</article>`;
}

export function formatsShell(state: FormatsShellState): string {
  const games = [{ value: '', label: 'Любая' }, ...state.games];

  return `<p class="eyebrow">Конструктор</p>
<h1>Форматы турнира</h1>
<p class="lede">Собери формат из кирпичиков, назови — и дальше запускай турнир по имени, не
перебирая настройки заново. Справа видно, что получится: это считает тот же код, что потом
строит настоящую сетку.</p>

<div class="builder">
  <div class="bricks">
    <section class="brick" style="--delay:0ms">
      <h2>Дисциплина</h2>
      <p class="hint">«Любая» — формат про форму вечера, а не про игру: дисциплину выберут при запуске или голосованием. Только такой формат годится ежедневному автомату.</p>
      ${opts('game', games)}
    </section>

    <section class="brick" style="--delay:40ms">
      <h2>Кто играет</h2>
      ${opts('entryMode', [
        { value: 'team', label: 'Команды' },
        { value: 'solo', label: 'Одиночки' },
      ])}
      <div class="nums" style="margin-top:.7rem">
        <label class="num"><span>В составе</span><input type="number" data-n="teamSize" min="2" max="10" step="1"></label>
        <label class="num"><span>Мест в сетке</span><input type="number" data-n="maxEntrants" min="2" max="64" step="1"></label>
      </div>
    </section>

    <section class="brick" style="--delay:80ms">
      <h2>Сетка</h2>
      <p class="hint">Двойное устранение примерно удваивает вечер: проигравший уходит в нижнюю сетку и может дойти до финала оттуда.</p>
      ${opts('format', [
        { value: 'single-elim', label: 'На выбывание' },
        { value: 'double-elim', label: 'Второй шанс' },
      ])}
    </section>

    <section class="brick" style="--delay:120ms">
      <h2>Матч</h2>
      ${opts('bestOf', [
        { value: '1', label: 'Одна карта' },
        { value: '3', label: 'До двух побед' },
        { value: '5', label: 'До трёх побед' },
      ])}
    </section>

    <section class="brick" style="--delay:160ms">
      <h2>Жеребьёвка</h2>
      ${opts('seeding', [
        { value: 'rank', label: 'По рангу' },
        { value: 'random', label: 'Случайно' },
      ])}
      <div class="nums" style="margin-top:.7rem">
        <label class="num"><span>Регистрация, ч</span><input type="number" data-n="registrationHours" min="1" max="72" step="1"></label>
      </div>
    </section>

    <section class="brick" style="--delay:200ms">
      <h2>Правила вечера</h2>
      <div class="toggles">
        ${toggle('abilities', 'Со способностями', 'Выключить — дуэль на прицел: драфта не будет вовсе.')}
        ${toggle('autoTeams', 'Составы собирает бот', 'Из записавшихся по одному, по силе. Только для командного формата.')}
        ${toggle('requireVerified', 'Нужна подтверждённая привязка', 'Без неё игрок идёт в жеребьёвке без ранга.')}
      </div>
    </section>

    <section class="brick" style="--delay:240ms">
      <h2>Имя формата</h2>
      <p class="hint">По нему турнир и запускают. Сохранение под существующим именем — правка, а не второй формат.</p>
      <div class="namebox">
        <input type="text" id="fname" maxlength="60" placeholder="Например: Вечерний 5×5" autocomplete="off">
        <textarea id="fnote" maxlength="200" placeholder="Заметка: чем этот формат отличается и когда его брать"></textarea>
      </div>
    </section>
  </div>

  <aside class="side">
    <div class="preview" id="prev">
      <h2 id="phead">Собери формат</h2>
      <ul id="plines"></ul>
      <ul class="warn" id="pwarn"></ul>
    </div>
    <div class="act">
      <button type="button" class="btn" id="save">Сохранить</button>
      <button type="button" class="btn ghost" id="reset">Начать заново</button>
    </div>
    <p class="said" id="said" role="status" aria-live="polite"></p>
  </aside>
</div>

<section class="saved">
  <h2 class="eyebrow" style="margin-top:1rem">Сохранённые форматы (${state.cards.length} из ${state.limit})</h2>
  <div id="cards">${state.cards.map(cardHtml).join('') || '<p class="sum">Пока ни одного. Собери первый — он появится здесь.</p>'}</div>
</section>

${formatsBoot(state)}
<script>${SCRIPT}</script>`;
}

/**
 * Скрипт страницы. Он умеет ровно три вещи: держать выбранное, спрашивать у сервера
 * предпросмотр и отправлять сохранение. Ни одного правила про турниры здесь нет намеренно —
 * все они на сервере, и удвоить их значило бы однажды разойтись с ним.
 */
const SCRIPT = String.raw`
(function () {
  var token = document.currentScript.dataset.token || new URLSearchParams(location.search).get('t') || location.pathname.split('/').pop();
  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var DEFAULTS = { game: '', entryMode: 'team', teamSize: 5, maxEntrants: 16, format: 'single-elim',
    bestOf: 1, seeding: 'rank', abilities: true, autoTeams: false, requireVerified: true,
    registrationHours: 2 };
  var state = Object.assign({}, DEFAULTS);
  var editing = null;

  function paint() {
    document.querySelectorAll('.opt').forEach(function (b) {
      var mine = String(state[b.dataset.k]);
      b.setAttribute('aria-pressed', mine === b.dataset.v ? 'true' : 'false');
    });
    document.querySelectorAll('.tog').forEach(function (b) {
      b.setAttribute('aria-pressed', state[b.dataset.t] ? 'true' : 'false');
    });
    document.querySelectorAll('[data-n]').forEach(function (input) {
      if (document.activeElement !== input) input.value = state[input.dataset.n];
    });
    // Размер состава у одиночного турнира всегда один: поле не врёт, а выключается.
    var size = document.querySelector('[data-n="teamSize"]');
    if (size) size.disabled = state.entryMode === 'solo';
    document.querySelectorAll('.preset').forEach(function (card) {
      card.dataset.open = String(Number(card.dataset.id) === editing ? 1 : 0);
    });
  }

  var timer = null;
  function preview() {
    clearTimeout(timer);
    el('prev').dataset.busy = '1';
    timer = setTimeout(function () {
      post('preview', { bricks: state }).then(function (data) {
        el('prev').dataset.busy = '0';
        if (!data) return;
        if (data.error) { el('phead').textContent = data.error; el('plines').innerHTML = ''; el('pwarn').innerHTML = ''; return; }
        el('phead').textContent = data.headline;
        el('plines').innerHTML = data.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
        el('pwarn').innerHTML = data.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
      });
    }, 220);
  }

  function post(path, body) {
    return fetch('/api/formats/' + encodeURIComponent(token) + '/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().catch(function () { return { error: 'Сервер ответил непонятно.' }; }); })
      .catch(function () { return { error: 'Не дозвонился до сервера. Проверь связь.' }; });
  }

  function say(text, kind) {
    var node = el('said');
    node.textContent = text;
    node.dataset.kind = kind || '';
  }

  document.addEventListener('click', function (event) {
    var opt = event.target.closest('.opt');
    if (opt) {
      var raw = opt.dataset.v;
      state[opt.dataset.k] = raw === '' ? '' : (isNaN(Number(raw)) ? raw : Number(raw));
      // Одиночный турнир и автосбор несовместимы — снимаем сразу, чтобы сервер не отказывал
      // за то, чего человек не выбирал.
      if (state.entryMode === 'solo') state.autoTeams = false;
      paint(); preview(); return;
    }
    var tog = event.target.closest('.tog');
    if (tog) {
      state[tog.dataset.t] = !state[tog.dataset.t];
      if (tog.dataset.t === 'autoTeams' && state.autoTeams) state.entryMode = 'team';
      paint(); preview(); return;
    }
    var open = event.target.closest('[data-open]');
    if (open && open.dataset.open) {
      var card = document.querySelector('.preset[data-id="' + open.dataset.open + '"]');
      var data = JSON.parse(card.dataset.bricks || '{}');
      state = Object.assign({}, DEFAULTS, data.bricks || {});
      if (state.game === null) state.game = '';
      editing = Number(open.dataset.open);
      el('fname').value = data.name || '';
      el('fnote').value = data.note || '';
      paint(); preview();
      say('Формат открыт. Сохранение перезапишет его.', 'ok');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var del = event.target.closest('[data-del]');
    if (del) {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = 'Точно удалить?';
        setTimeout(function () { del.dataset.armed = '0'; del.textContent = 'Удалить'; }, 4000);
        return;
      }
      post('remove', { id: Number(del.dataset.del) }).then(function (data) {
        if (data.error) { say(data.error, 'err'); return; }
        render(data.cards);
        say('Формат «' + data.removed + '» удалён.', 'ok');
      });
      return;
    }
    if (event.target.closest('#reset')) {
      state = Object.assign({}, DEFAULTS); editing = null;
      el('fname').value = ''; el('fnote').value = '';
      paint(); preview(); say('');
    }
  });

  document.addEventListener('input', function (event) {
    var input = event.target.closest('[data-n]');
    if (!input) return;
    var value = Number(input.value);
    if (!Number.isFinite(value)) return;
    state[input.dataset.n] = value;
    preview();
  });

  el('save').addEventListener('click', function () {
    var name = el('fname').value.trim();
    if (!name) { say('Дай формату имя — по нему его и запускают.', 'err'); el('fname').focus(); return; }
    el('save').disabled = true;
    post('save', { name: name, note: el('fnote').value, bricks: state, id: editing }).then(function (data) {
      el('save').disabled = false;
      if (data.error) { say(data.error, 'err'); return; }
      render(data.cards);
      editing = data.id;
      paint();
      say(data.created ? 'Формат «' + name + '» сохранён.' : 'Формат «' + name + '» обновлён.', 'ok');
    });
  });

  function render(cards) {
    el('cards').innerHTML = cards.html;
    document.querySelectorAll('.preset').forEach(function (card) {
      var found = cards.data.filter(function (c) { return c.id === Number(card.dataset.id); })[0];
      if (found) card.dataset.bricks = JSON.stringify(found);
    });
    var counter = document.querySelector('.saved .eyebrow');
    if (counter) counter.textContent = 'Сохранённые форматы (' + cards.data.length + ' из ' + cards.limit + ')';
    paint();
  }

  render(window.__FORMATS__);
  paint();
  preview();
})();
`;

/**
 * Начальные данные встраиваются в страницу, а не запрашиваются вторым запросом: иначе первый
 * кадр был бы пустым. `<` экранируется — строка вида `</script>` внутри данных иначе закрыла
 * бы тег и превратила данные в разметку.
 */
export function formatsBoot(state: FormatsShellState): string {
  const payload = {
    limit: state.limit,
    data: state.cards,
    html: state.cards.map(cardHtml).join('') || '<p class="sum">Пока ни одного. Собери первый — он появится здесь.</p>',
  };
  return `<script>window.__FORMATS__=${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script>`;
}

/** Разметка списка карточек — она же уходит в ответ на сохранение и удаление. */
export function formatCardsHtml(cards: FormatCard[]): string {
  return cards.map(cardHtml).join('') || '<p class="sum">Пока ни одного. Собери первый — он появится здесь.</p>';
}

/** Страница «ссылка не действует». Отдельная, потому что отказ надо объяснить, а не показать 404. */
export function formatsDenied(): string {
  return `<p class="eyebrow">Конструктор</p>
<h1>Ссылка не действует</h1>
<p class="lede">Пропуск в конструктор живёт сутки, и на человека он один: выдача новой ссылки гасит прежнюю.
Это и есть способ отозвать доступ — другого у ссылки, которую можно переслать, не бывает.</p>
<div class="empty"><p>Попроси новую командой <code>/tournament formats</code> в Discord.</p>
<p>Команда доступна тем, у кого есть право «Управление сервером»: формат задаёт, каким будет вечер для всех.</p></div>`;
}
