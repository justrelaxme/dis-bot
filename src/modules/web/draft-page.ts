import type { DraftGroup, DraftOption, DraftSide } from '../tournaments/draft/pools.js';
import { GROUP_LABELS } from '../tournaments/draft/pools.js';
import { escape } from './render.js';

/**
 * Страница драфта. Единственная страница витрины, где что-то нажимают, — поэтому здесь
 * единственный скрипт в проекте.
 *
 * **Полотно рисуется один раз, а меняются только состояния плиток.** Так сделано ради того
 * единственного, что на этой странице происходит: бана. Если перерисовывать разметку целиком
 * на каждый опрос, плитка исчезала бы и появлялась заново, а вместе с ней исчезала бы и
 * возможность её перечеркнуть на глазах. Постоянные плитки означают, что переход состояния
 * виден: карта обесцвечивается и получает косую черту, а взятая — цветную полосу команды.
 *
 * И это не только про красоту. Пул целиком на экране отвечает на вопрос «что уже ушло», а
 * пул из одних доступных вариантов на него не отвечает: забаненное просто пропадало, и
 * сравнить его было не с чем.
 *
 * Опрос, а не веб-сокеты: драфт живёт минуты, участников двое плюс зрители, а сокет — это
 * отдельное соединение, отдельные обрывы и отдельный способ сломаться. Раз в две секунды
 * достаточно, чтобы ход соперника выглядел мгновенным. Пул в ответах опроса не приходит: он
 * не меняется, а сто двадцать семь героев каждые две секунды — это тридцать килобайт зря.
 *
 * Таймер в браузере — подсказка. Решает всё равно сервер: он ставит дедлайн и он же двигает
 * просроченный ход джобой. Расхождение часов клиента ни на что не влияет.
 */

export const DRAFT_STYLE = `
/* ── Две стороны и ход между ними ──────────────────────────────────────────────────────
   Плашки команд — не заголовок, а указатель: активная сторона обведена своим цветом, и
   чей ход, видно раньше, чем прочитан текст. */
.duel { display:grid; grid-template-columns:1fr minmax(10.5rem,13rem) 1fr; gap:.7rem; align-items:stretch;
  margin:0 0 1rem; animation:enter .45s var(--ease) .1s both; }
.team { position:relative; border:1px solid var(--rule); clip-path:var(--panel); padding:.6rem .85rem .65rem;
  background:var(--sheet); overflow:hidden; transition:border-color .25s, box-shadow .25s; }
.team.ta { --who:var(--side-a); }
.team.tb { --who:var(--side-b); text-align:right; }
.team::before { content:''; position:absolute; inset:0 auto 0 0; width:3px; background:var(--who);
  transform:scaleY(.25); transform-origin:top; transition:transform .3s ease; }
.team.tb::before { inset:0 0 0 auto; }
.team.act { border-color:var(--who); }
.team.act::before { transform:scaleY(1); }
.team .tn { display:block; font-weight:800; font-size:clamp(.98rem,3vw,1.35rem); line-height:1.1;
  letter-spacing:-.02em; text-transform:uppercase; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
.team .tr { display:block; font-family:var(--mono); font-size:.62rem; letter-spacing:.18em;
  text-transform:uppercase; color:var(--dim); margin-top:.1rem; }
/* Полоса взятого: лица тех, кого команда уже забрала. Она и есть ответ на «что у них». */
.team .tp { display:flex; gap:.25rem; flex-wrap:wrap; margin-top:.5rem; min-height:1.7rem; }
.team.tb .tp { justify-content:flex-end; }
.team .tp img { width:28px; height:28px; object-fit:cover;
  border:1px solid var(--who); background:var(--sheet-2);
  animation:enter .3s var(--ease) both; }
.team .tp .none { font-family:var(--mono); font-size:.68rem; color:var(--rule); }

.clash { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.4rem; }
.turn { position:relative; width:100%; text-align:center; overflow:hidden;
  font-family:var(--mono); font-size:.76rem; letter-spacing:.06em;
  border:1px solid var(--rule); padding:.45rem .7rem .5rem;
  transition:border-color .25s, color .25s; }
.turn.mine { border-color:var(--accent); color:var(--accent); }
.turn.over { border-color:var(--ember); color:var(--ember); }
.clock { display:block; font-size:1.15rem; line-height:1.15; font-variant-numeric:tabular-nums; }
/* Запал: время хода утекает полосой. Цифра говорит сколько, полоса — сколько это на глаз. */
.fuse { position:absolute; left:0; bottom:0; height:2px; width:100%; background:var(--accent);
  transform-origin:left; transition:transform 1s linear; }
.turn.over .fuse { background:var(--ember); }
.skip { background:none; border:1px solid var(--rule); color:var(--dim); font-family:var(--mono);
  font-size:.72rem; padding:.32rem .6rem; cursor:pointer; }
.skip:hover:not([disabled]) { border-color:var(--bone); color:var(--bone); }
.skip[disabled] { opacity:.4; cursor:default; }
@media (max-width:640px) {
  .duel { grid-template-columns:1fr; }
  .team.tb { text-align:left; }
  .team.tb::before { inset:0 auto 0 0; }
  .team.tb .tp { justify-content:flex-start; }
}

/* Подсказка «что дальше»: акцентная риска слева, чтобы её замечали, но не спутали с ходом. */
.next { color:var(--bone); font-size:.94rem; margin:0 0 .2rem; padding-left:.85rem;
  border-left:2px solid var(--accent); min-height:1.35em; }
.err { color:var(--ember); font-family:var(--mono); font-size:.8rem; min-height:1.2em; margin:.5rem 0 0; }

/* ── Фаза ───────────────────────────────────────────────────────────────────────────── */
.phase { margin-top:2rem; }
.phase h2 { margin:0 0 .8rem; display:flex; align-items:baseline; gap:.75rem; flex-wrap:wrap; }
.phase h2::after { display:none; }
/* Номер фазы горит акцентом только у той, где ходят сейчас: он и отвечает «где мы». */
.phase h2 .num { font-family:var(--mono); color:var(--dim); letter-spacing:.1em; }
.phase h2 .pm { color:var(--dim); letter-spacing:.12em; }
.phase.act h2 { color:var(--bone); }
.phase.act h2 .num, .phase.act h2 .pm { color:var(--accent); }
.phase .pres { font-size:.92rem; color:var(--dim); margin:.7rem 0 0; }
.phase .pres b { color:var(--accent); }
/* Фаза, до которой ещё не дошли или которая уже прошла, отступает: свободные варианты в ней
   гаснут, а занятые остаются видны — они и есть её содержание. */
.phase:not(.act) .tile.free { opacity:.3; }
.filter { width:100%; max-width:22rem; background:var(--sheet); color:var(--bone); font-family:var(--mono);
  font-size:.85rem; border:1px solid var(--rule); padding:.5rem .7rem; margin-bottom:.8rem; }
.filter:focus { outline:none; border-color:var(--accent); }

/* ── Плитка ─────────────────────────────────────────────────────────────────────────────
   Картинка честного цвета: по ней принимают решение, а обесцвеченная карта не узнаётся.
   Обесцвечивание здесь означает ровно одно — этот вариант выбыл. */
/* Размер плитки и пропорция картинки заданы здесь **по умолчанию**, а не только у каждого
   набора по отдельности. Это не аккуратность, а предохранитель: пока правило было лишь
   персональным, новый набор оставался вообще без сетки и без пропорции — то есть одна плитка
   на всю ширину, а картинка в свой натуральный размер. Именно так и вышли гигантские портреты
   персонажей Genshin. Теперь набор без своего правила выглядит просто как остальные. */
.board { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); }
.phase[data-group="maps"] .board { grid-template-columns:repeat(auto-fill,minmax(148px,1fr)); }
.phase[data-group="agents"] .board { grid-template-columns:repeat(auto-fill,minmax(104px,1fr)); }
/* Персонажей больше сотни, а чемпионов больше двух сотен: плитка им нужна мельче, иначе
   полотно уезжает на три экрана. */
.phase[data-group="characters"] .board { grid-template-columns:repeat(auto-fill,minmax(82px,1fr)); }
.phase[data-group="champions"] .board { grid-template-columns:repeat(auto-fill,minmax(78px,1fr)); }

.tile { position:relative; display:block; width:100%; padding:0; text-align:left; overflow:hidden;
  background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel); color:inherit;
  font:inherit; cursor:default;
  animation:enter .3s var(--ease) both; animation-delay:var(--delay,0ms);
  transition:border-color .2s, transform .2s, opacity .35s, box-shadow .25s; }
.tile .art { position:relative; display:block; overflow:hidden; background:var(--sheet-2);
  aspect-ratio:16/9; }
.phase[data-group="agents"] .tile .art { aspect-ratio:2/1; }
/* Иконки персонажей Genshin и чемпионов LoL квадратные — 128×128 обе. */
.phase[data-group="characters"] .tile .art,
.phase[data-group="champions"] .tile .art { aspect-ratio:1/1; }
.tile .art img { display:block; width:100%; height:100%; object-fit:cover;
  transition:filter .4s, transform .4s var(--ease), opacity .3s; }
/* Схема карты открывается по наведению. Это не украшение: по планировке карту и выбирают. */
.tile .art img.alt { position:absolute; inset:0; opacity:0; object-fit:contain;
  background:var(--ink-2); padding:4%; }
.tile .tl { display:block; padding:.34rem .5rem .38rem; font-family:var(--mono); font-size:.72rem;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile .by { display:none; }

.tile.hot { cursor:pointer; }
.tile.hot:hover, .tile.hot:focus-visible { border-color:var(--accent); transform:translateY(-3px);
  box-shadow:0 8px 20px -12px #000; }
.tile.hot:hover .art img:not(.alt), .tile.hot:focus-visible .art img:not(.alt) { transform:scale(1.07); }
.tile.hot:hover .art img.alt, .tile.hot:focus-visible .art img.alt { opacity:1; }

/* Бан: косая черта прочерчивается один раз, слева направо. Она и есть тот момент, ради
   которого плитки живут постоянно. */
.tile.banned { opacity:.55; }
.tile.banned .art img { filter:grayscale(1) brightness(.4) contrast(1.1); }
.tile.banned .tl { color:var(--dim); text-decoration:line-through; }
.tile.banned .art::after { content:''; position:absolute; left:-12%; right:-12%; top:calc(50% - 1px);
  height:2px; background:color-mix(in srgb, var(--bone) 72%, transparent); rotate:-13deg; transform-origin:left;
  animation:strike .34s cubic-bezier(.2,.8,.2,1) both; }
@keyframes strike { from { transform:scaleX(0); } to { transform:scaleX(1); } }

/* Взято: полоса цвета команды вырастает поперёк верха, и подпись говорит, чьё это.
   Обе стороны на одном герое — законное состояние: полоса делится пополам, по цвету каждой.
   Это и есть зеркальный пул, и видно его должно быть сразу. */
.tile.by-a { --who:var(--side-a); }
.tile.by-b { --who:var(--side-b); }
.tile.by-both { --who:var(--bone); }
.tile.by-a, .tile.by-b, .tile.by-both { border-color:var(--who); }
.tile.by-a::before, .tile.by-b::before, .tile.by-both::before { content:''; position:absolute;
  inset:0 0 auto; height:3px; background:var(--who); z-index:2; transform-origin:left;
  animation:strike .3s var(--ease) both; }
.tile.by-both::before { background:linear-gradient(90deg,var(--side-a) 0 50%,var(--side-b) 50% 100%); }
.tile.by-a .by, .tile.by-b .by, .tile.by-both .by { display:block; padding:0 .5rem .36rem;
  font-family:var(--mono); font-size:.6rem; letter-spacing:.1em; text-transform:uppercase;
  color:var(--who); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* Нет на аккаунте. Только у персонажей Genshin и только когда состав удалось прочитать:
   банить персонажа, которого у соперника и не было, — потраченный ход, и знать это надо до
   хода. Плитка при этом остаётся нажимаемой: Летопись обновляется с задержкой, и вчерашняя
   крутка в ней ещё не появилась. Это сведения, а не запрет. */
.tile .lack { position:absolute; left:0; right:0; top:0; z-index:2; padding:.16rem .3rem;
  font-family:var(--mono); font-size:.56rem; letter-spacing:.08em; text-transform:uppercase;
  background:color-mix(in srgb,var(--ink) 82%,transparent); color:var(--dim);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile.lacks-you .art img { filter:grayscale(.6) brightness(.72); }

/* Итог фазы. Стоит после занятых нарочно: карта, которую выбрали, — тоже итог, и её рамка
   должна быть акцентной, а не цветом выбравшей команды. */
.tile.won { border-color:var(--accent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 32%,transparent), 0 0 28px -14px var(--accent); }
.tile.won .tl { color:var(--accent); }
.tile.won .art img { filter:none; }
.phase:not(.act) .tile.won { opacity:1; }
`;

/**
 * Начальное состояние встраивается в страницу, а не запрашивается вторым запросом: иначе
 * первый кадр был бы пустым. `<` экранируется — иначе строка вида `</script>` внутри данных
 * закрыла бы тег и превратила данные в разметку.
 */
function inlineState(state: unknown): string {
  return JSON.stringify(state).replaceAll('<', '\\u003c');
}

export interface DraftShellState {
  matchId: number;
  tournamentName: string;
  teams: { a: string; b: string };
  you: 'a' | 'b' | null;
  pool?: DraftOption[];
  phases: { group: DraftGroup; total: number; done: number; resultIds: string[] }[];
}

/**
 * Чего не хватает на аккаунте — с точки зрения того, кто смотрит.
 *
 * Пустая пометка означает «неизвестно», а не «есть у всех»: состав читается только у
 * подтверждённых одиночек с публичной Летописью, и во всех прочих случаях пометок нет вовсе.
 * Зрителю без стороны не показывается ничего — пометка нужна тому, кто делает ход.
 */
function lacking(option: DraftOption, you: DraftSide | null): { text: string; mine: boolean } | null {
  if (!option.owned || !you) return null;
  const foe: DraftSide = you === 'a' ? 'b' : 'a';
  if (!option.owned.includes(you)) return { text: 'нет у тебя', mine: true };
  if (!option.owned.includes(foe)) return { text: 'нет у соперника', mine: false };
  return null;
}

/** Плитка варианта. Разметка ставится один раз — дальше меняется только класс. */
function tile(option: DraftOption, index: number, you: DraftSide | null): string {
  const art = option.imageUrl
    ? `<img src="${escape(option.imageUrl)}" alt="${escape(option.label)}" loading="lazy" decoding="async">`
    : '';
  // Схема — только там, где она отличается от основной картинки: у карт. У героя и агента
  // иконка это та же картинка помельче, и открывать её по наведению было бы бессмысленно.
  const scheme =
    option.group === 'maps' && option.iconUrl
      ? `<img class="alt" src="${escape(option.iconUrl)}" alt="" loading="lazy" decoding="async">`
      : '';

  const lack = lacking(option, you);
  const note = lack ? `<span class="lack">${escape(lack.text)}</span>` : '';

  return `<button type="button" class="tile free${lack?.mine ? ' lacks-you' : ''}" data-id="${escape(option.id)}" style="--delay:${Math.min(index, 24) * 18}ms">
<span class="art">${art}${scheme}${note}</span>
<span class="tl">${escape(option.label)}</span>
<span class="by"></span>
</button>`;
}

/**
 * Пояснение к фазе. У героев и агентов оно про зеркальный пул, и это главное, что надо
 * сказать: иначе первый же капитан решит, что взятый соперником герой у него отобран.
 */
const PHASE_LEAD: Record<DraftGroup, string> = {
  maps: 'Банят по очереди. Оставшаяся карта — решающая: её никто не выбирал, поэтому спорить не о чем.',
  heroes:
    'Сначала баны, потом пики змейкой. Забаненного не берёт никто. А вот взятого соперником взять можно — чужой пик виден, и под него берут контрпик.',
  agents:
    'Сначала баны, потом пики. Забаненного не берёт никто, но взятого соперником взять можно: его пик виден, и под него подбирают ответ.',
  characters:
    'Восемь пиков на этаж: четыре на первую половину, четыре на вторую. Забаненного не берёт никто, а взятого соперником взять можно — свой аккаунт от чужого выбора не меняется.',
  champions:
    'Сначала баны, потом пики змейкой. Забаненного не берёт никто, а взятого соперником взять можно — под чужой пик и берут контрпик. В клиенте так не выйдет: в режиме отбора чемпион уникален на две команды, поэтому играть этот драфт надо в слепом выборе или в лобби.',
};

export function draftShell(state: DraftShellState): string {
  const pool = state.pool ?? [];
  const groups = state.phases.map((phase) => phase.group);

  const sections = state.phases
    .map((phase, order) => {
      const options = pool.filter((option) => option.group === phase.group);
      const labels = GROUP_LABELS[phase.group];
      const search =
        options.length > 24
          ? `<input class="filter" data-filter="${phase.group}" placeholder="Поиск — ${escape(
              labels.of,
            )}" autocomplete="off" aria-label="Поиск: ${escape(labels.many.toLowerCase())}">`
          : '';

      return `<section class="phase" data-group="${phase.group}" id="ph-${phase.group}">
<h2><span class="num">Фаза ${order + 1}</span> ${escape(labels.many)} <span class="pm" data-pm="${phase.group}"></span></h2>
<p class="lede">${PHASE_LEAD[phase.group]}</p>
${search}
<div class="board" data-board="${phase.group}">${options.map((option, index) => tile(option, index, state.you)).join('')}</div>
<p class="pres" data-pres="${phase.group}"></p>
</section>`;
    })
    .join('\n');

  const twoPhase = groups.length > 1;

  return `<p class="eyebrow">${escape(state.tournamentName)}</p>
<h1>Драфт</h1>
<p class="lede">${
    twoPhase
      ? 'Сначала делите карту, потом агентов. Ходы идут по очереди, страница обновляется сама.'
      : 'Ходы идут по очереди, страница обновляется сама — перезагружать не надо.'
  }</p>

<div class="duel">
  <div class="team ta" id="teamA">
    <span class="tn" id="nameA">—</span>
    <span class="tr">сторона A</span>
    <span class="tp" id="picksA"></span>
  </div>
  <div class="clash">
    <span class="turn" id="turn">загрузка…<i class="fuse" id="fuse"></i></span>
    <button class="skip" id="skip" hidden>Пропустить бан</button>
  </div>
  <div class="team tb" id="teamB">
    <span class="tn" id="nameB">—</span>
    <span class="tr">сторона B</span>
    <span class="tp" id="picksB"></span>
  </div>
</div>

<p class="next" id="next"></p>
<p class="err" id="err" role="status"></p>

${sections}

<script>
(function () {
  var state = ${inlineState(state)};
  var token = new URLSearchParams(location.search).get('as') || '';
  /** Пул приходит один раз, со страницей: в ответах опроса его нет — он не меняется. */
  var pool = state.pool || [];
  var byId = {};
  pool.forEach(function (option) { byId[option.id] = option; });
  var filters = {};

  var el = function (id) { return document.getElementById(id); };
  var esc = function (value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  var teamName = function (side) { return side === 'a' ? state.teams.a : state.teams.b; };

  function myTurn() {
    return !state.done && state.you && state.current && state.current.side === state.you;
  }

  /**
   * Подсказка «что дальше». Одна строка про текущее положение, а не инструкция целиком:
   * человек на этой странице занят ходом, а не чтением. Меняется с каждым состоянием,
   * потому что «что дальше» у ждущего и у ходящего — разные вещи.
   */
  function nextHint() {
    if (state.done) {
      var last = state.phases[state.phases.length - 1];
      if (last && last.group === 'maps') {
        return 'Драфт закончен. Создавайте лобби на выбранной карте, играйте, и победитель пишет /match report в ветке матча.';
      }
      return 'Драфт закончен. Собирайтесь в лобби, берите то, что выбрали, — забаненное не берёт никто. После игры победитель пишет /match report.';
    }
    if (!state.you) {
      return 'Ты смотришь: ходят капитаны по своим ссылкам. Страница обновляется сама, перезагружать не надо.';
    }
    if (!state.current) return 'Ждём начала.';
    if (state.current.side !== state.you) {
      return 'Ход соперника. Как только он выберет, здесь появится твоя очередь — страница обновится сама.';
    }
    var what = { maps: 'карту', heroes: 'героя', agents: 'агента' }[state.current.group] || 'вариант';
    if (state.current.kind === 'ban') {
      return 'Твой бан: убери ' + what + ', которую не хочешь видеть в игре. Можно и пропустить — тогда бан просто не случится.';
    }
    return 'Твой пик: возьми ' + what + ' себе. Соперник его уже не возьмёт.';
  }

  /** Взят ли вариант этой стороной. Один и тот же герой может стоять сразу у обеих. */
  function heldBy(id, side) { return state.picks[side].indexOf(id) >= 0; }
  function isBanned(id) { return state.banned.indexOf(id) >= 0; }

  /**
   * Класс плитки целиком: состояние варианта плюс право на него нажать.
   *
   * Нажать нельзя по забаненному и по тому, что уже взяла **своя** сторона. По взятому
   * соперником — можно, если пики в этом наборе зеркальные: в этом и смысл контрпика.
   */
  function tileClass(id, group, resultIds) {
    var mirrored = group !== 'maps';
    var banned = isBanned(id);
    var byA = heldBy(id, 'a');
    var byB = heldBy(id, 'b');

    var classes = ['tile'];
    if (banned) classes.push('banned');
    else if (byA && byB) classes.push('by-both');
    else if (byA) classes.push('by-a');
    else if (byB) classes.push('by-b');
    else classes.push('free');

    if (resultIds.indexOf(id) >= 0) classes.push('won');

    if (myTurn() && state.current.group === group) {
      var mine = heldBy(id, state.you);
      var blocked = banned || mine || (!mirrored && (byA || byB));
      if (!blocked) classes.push('hot');
    }
    return classes.join(' ');
  }

  function renderTeams() {
    el('nameA').textContent = state.teams.a;
    el('nameB').textContent = state.teams.b;
    ['a', 'b'].forEach(function (side) {
      var plate = el(side === 'a' ? 'teamA' : 'teamB');
      var active = state.current && state.current.side === side;
      plate.className = 'team t' + side + (active ? ' act' : '');

      var taken = state.picks[side];
      el(side === 'a' ? 'picksA' : 'picksB').innerHTML = taken.length
        ? taken.map(function (id) {
            var option = byId[id] || { label: id };
            var src = option.iconUrl || option.imageUrl;
            return src
              ? '<img src="' + esc(src) + '" alt="' + esc(option.label) + '" title="' + esc(option.label) + '">'
              : '<span class="none">' + esc(option.label) + '</span>';
          }).join('')
        : '<span class="none">пока ничего</span>';
    });
  }

  function renderTurn() {
    var turn = el('turn');
    var fuse = '<i class="fuse" id="fuse"></i>';
    if (state.done) {
      turn.className = 'turn';
      turn.innerHTML = 'Драфт закончен' + fuse;
    } else if (!state.current) {
      turn.className = 'turn';
      turn.innerHTML = 'Ожидание' + fuse;
    } else {
      var ban = state.current.kind === 'ban';
      // Своё действие называется существительным, чужое — глаголом: «Твой ход · бан», но
      // «Кобры · банят». Иначе выходит «Твой ход · банит» — не про того человека.
      var label = myTurn()
        ? 'Твой ход · ' + (ban ? 'бан' : 'пик')
        : esc(teamName(state.current.side)) + ' · ' + (ban ? 'банит' : 'выбирает');
      turn.className = 'turn' + (myTurn() ? ' mine' : '');
      turn.innerHTML = label + '<span class="clock" id="clock"></span>' + fuse;
    }

    var skip = el('skip');
    var canSkip = myTurn() && state.current.kind === 'ban';
    skip.hidden = !canSkip;
    skip.disabled = !canSkip;
  }

  function renderPhases() {
    state.phases.forEach(function (phase) {
      var section = el('ph-' + phase.group);
      if (!section) return;
      var active = !state.done && state.current && state.current.group === phase.group;
      section.className = 'phase' + (active ? ' act' : '');

      var meta = section.querySelector('[data-pm]');
      if (meta) meta.textContent = phase.done + ' из ' + phase.total;

      var board = section.querySelector('[data-board]');
      var needle = filters[phase.group] || '';
      Array.prototype.forEach.call(board.children, function (button) {
        var id = button.dataset.id;
        // Класс присваивается целиком и только при изменении: повторное присваивание того же
        // значения не перезапустило бы анимацию, но и трогать разметку зря незачем.
        var next = tileClass(id, phase.group, phase.resultIds);
        if (button.className !== next) button.className = next;

        var by = button.querySelector('.by');
        var holders = [];
        if (!isBanned(id)) {
          if (heldBy(id, 'a')) holders.push(state.teams.a);
          if (heldBy(id, 'b')) holders.push(state.teams.b);
        }
        // «Пантеры и Кобры» — обе взяли одного героя. Это законно, и промолчать об этом
        // значило бы показать плитку взятой неизвестно кем.
        var label = holders.join(' и ');
        if (by.textContent !== label) by.textContent = label;

        var option = byId[id] || { label: '' };
        var hidden = needle && option.label.toLowerCase().indexOf(needle) < 0;
        button.hidden = !!hidden;
      });

      var result = section.querySelector('[data-pres]');
      if (!result) return;
      if (phase.done < phase.total || phase.resultIds.length === 0) {
        result.innerHTML = '';
        return;
      }
      var names = phase.resultIds.map(function (id) { return esc((byId[id] || { label: id }).label); });
      result.innerHTML =
        phase.group === 'maps'
          ? 'Играете на <b>' + names.join('</b>, <b>') + '</b>. Оставшуюся карту не выбирал никто — она решающая.'
          : 'Взято: <b>' + names.join('</b>, <b>') + '</b>. Воспроизведите это в лобби.';
    });
  }

  function render() {
    renderTeams();
    renderTurn();
    renderPhases();
    el('next').textContent = nextHint();
    tick();
  }

  /**
   * Отсчёт. Полоса запала показывает остаток от минуты — не от фактического дедлайна, а от
   * постоянной длины хода: иначе после автохода полоса прыгала бы с середины.
   */
  var STEP_MS = 60000;
  function tick() {
    var clock = el('clock');
    var fuse = el('fuse');
    if (!state.deadlineAt) {
      if (clock) clock.textContent = '';
      if (fuse) fuse.style.transform = 'scaleX(0)';
      return;
    }
    var leftMs = Math.max(0, new Date(state.deadlineAt).getTime() - Date.now());
    var left = Math.round(leftMs / 1000);
    if (clock) clock.textContent = left + ' с';
    if (fuse) fuse.style.transform = 'scaleX(' + Math.min(1, leftMs / STEP_MS) + ')';
    el('turn').classList.toggle('over', left === 0);
  }

  function apply(next) {
    // Пул в ответах опроса не приходит — тот, что пришёл со страницей, остаётся.
    if (!next.pool) next.pool = pool;
    state = next;
    render();
  }

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

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.tile') : null;
    if (!button || !button.classList.contains('hot')) return;
    choose(button.dataset.id);
  });

  el('skip').addEventListener('click', function () { choose(null); });

  Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (input) {
    input.addEventListener('input', function () {
      filters[input.dataset.filter] = input.value.trim().toLowerCase();
      renderPhases();
    });
  });

  render();
  setInterval(tick, 1000);
  // Опрос продолжается и после конца драфта, но реже: страница остаётся протоколом, и
  // зритель, открывший её позже, должен увидеть итог без перезагрузки.
  setInterval(function () { if (!state.done) refresh(); }, 2000);
  setInterval(function () { if (state.done) refresh(); }, 30000);
})();
</script>`;
}
