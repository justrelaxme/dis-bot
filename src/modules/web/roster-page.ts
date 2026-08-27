import { formatCost } from '../tournaments/genshin/cost.js';
import type { RosterEntry } from '../tournaments/services/rosters.js';
import { escape } from './render.js';

/**
 * Заявка состава на турнир по Genshin: страница, на которой игрок видит **свой** аккаунт и
 * выбирает, с кем идёт.
 *
 * Ради этой страницы всё и затевалось. Пул драфта — это все сто с лишним персонажей игры, и по
 * нему не видно ни того, что есть у человека, ни того, во сколько ему обойдётся взятый герой.
 * Здесь наоборот: только своё, с созвездием, оружием и ценой, и с остатком бюджета на виду.
 *
 * Потолок проверяет сервер, а не эта страница. Она считает то же самое и не даёт нажать
 * «Заявить», когда бюджет превышен, — но заявка, отправленная мимо неё, упрётся в тот же
 * предел. Иначе потолок был бы подсказкой, а не правилом.
 */

export const ROSTER_STYLE = `
.purse { position:sticky; top:0; z-index:3; display:flex; flex-wrap:wrap; gap:.6rem 1.2rem;
  align-items:baseline; padding:.6rem .8rem; margin:0 0 1rem;
  background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel);
  font-family:var(--mono); font-size:.8rem; }
.purse .who { color:var(--dim); }
.purse b { color:var(--bone); font-weight:500; font-size:1rem; }
.purse.over b { color:var(--ember); }
.purse .act { margin-left:auto; display:flex; gap:.5rem; }

.btn { font-family:var(--mono); font-size:.8rem; letter-spacing:.06em; padding:.5rem .9rem;
  background:var(--accent); color:var(--ink); border:1px solid var(--accent); clip-path:var(--panel);
  cursor:pointer; transition:transform .16s var(--ease), opacity .16s; }
.btn:active { transform:translateY(1px); }
.btn[disabled] { opacity:.45; cursor:default; }
.btn.ghost { background:none; color:var(--dim); border-color:var(--rule); }
.btn.ghost:hover { color:var(--bone); border-color:var(--accent); }
.btn:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }

.said { font-family:var(--mono); font-size:.78rem; min-height:1.2rem; color:var(--dim); margin:.2rem 0 1rem; }
.said[data-kind="ok"] { color:var(--accent); }
.said[data-kind="err"] { color:var(--ember); }

.filter { width:100%; max-width:22rem; margin:0 0 .8rem; background:var(--ink-2); color:var(--bone);
  border:1px solid var(--rule); padding:.45rem .7rem; font-family:var(--mono); font-size:.8rem; }
.filter:focus { outline:none; border-color:var(--accent); }

.roster { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); }

/* Карточка персонажа. Всё, что нужно для решения, стоит на ней: созвездие, оружие с огранкой,
   комплект артефактов и цена. Цена справа и крупнее прочего — по ней и выбирают. */
.who4 { position:relative; display:flex; gap:.6rem; align-items:center; text-align:left; width:100%;
  padding:.5rem .6rem; background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel);
  color:inherit; font:inherit; cursor:pointer;
  transition:border-color .18s, transform .18s var(--ease), opacity .2s; }
.who4:hover { border-color:color-mix(in srgb,var(--accent) 50%,var(--rule)); }
.who4:active { transform:translateY(1px); }
.who4:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.who4[aria-pressed="true"] { border-color:var(--accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 40%,transparent); }
.who4 img { width:44px; height:44px; flex:0 0 auto; object-fit:cover; background:var(--sheet-2); }
.who4 .txt { display:grid; gap:.1rem; min-width:0; }
.who4 .nm { font-size:.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.who4 .sub { font-family:var(--mono); font-size:.62rem; color:var(--dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.who4 .pt { margin-left:auto; font-family:var(--mono); font-size:.9rem; color:var(--accent); }
.who4[data-free="1"] .pt { color:var(--dim); }
/* Не влезает в остаток — приглушаем, но нажать даём: сначала убрать кого-то, потом взять. */
.who4.too { opacity:.42; }
.who4[hidden] { display:none; }

/* Иммуны. Отдельным разделом, а не третьим состоянием карточки: «взят» и «взят и защищён» на
   одной кнопке читались бы как одно и то же, и попасть мимо было бы легко. */
.immune { margin:0 0 1rem; padding:.7rem .8rem; background:var(--sheet);
  border:1px solid var(--rule); clip-path:var(--panel); }
.immune h2 { font-family:var(--mono); font-size:.72rem; letter-spacing:.14em; text-transform:uppercase;
  color:var(--dim); margin:0 0 .3rem; font-weight:400; }
.immune .hint { color:var(--dim); font-size:.8rem; margin:0 0 .6rem; }
.chips { display:flex; flex-wrap:wrap; gap:.4rem; }
.chip { font-family:var(--mono); font-size:.76rem; padding:.35rem .6rem; color:var(--dim);
  background:var(--sheet-2); border:1px solid var(--rule); clip-path:var(--panel); cursor:pointer;
  transition:color .18s, border-color .18s; }
.chip:hover { color:var(--bone); }
.chip[aria-pressed="true"] { color:var(--ink); background:var(--accent); border-color:var(--accent); }
.chip:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.immune .none { color:var(--dim); font-size:.8rem; }

/* Персонаж под иммуном виден и в списке: иначе отметку пришлось бы держать в голове. */
.who4[data-immune="1"] .nm::after { content:' 🛡'; }

@media (prefers-reduced-motion:reduce) { .who4 { transition:none; } }
`;

export interface RosterShellState {
  token: string;
  tournamentName: string;
  /** Потолок стоимости в очках. `null` — без потолка: играют чем есть. */
  cap: number | null;
  /** Сколько персонажей можно заявить. Правило игры, а не настройка сервера. */
  limit: number;
  /** Весь аккаунт игрока: только его персонажи, с ценой каждого. */
  owned: RosterEntry[];
  /** Уже заявленные — страница открывается с ними, а не с чистого листа. */
  chosen: string[];
  /**
   * Сколько персонажей можно защитить от бана. Ноль — иммунов в этом турнире нет, и раздела
   * про них на странице не будет вовсе.
   */
  immunities: number;
  /** Кто уже под иммуном. */
  immune: string[];
  /** Игровой ник, чтобы человек видел, чей это аккаунт. */
  nickname: string;
}

function characterCard(entry: RosterEntry, chosen: boolean): string {
  const sub = [
    `C${entry.constellation}`,
    entry.weapon ? `${entry.weapon.name} R${entry.weapon.refinement}` : 'без оружия',
    entry.sets ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

  const art = entry.iconUrl
    ? `<img src="${escape(entry.iconUrl)}" alt="" loading="lazy" decoding="async">`
    : '';

  return `<button type="button" class="who4" data-id="${escape(entry.id)}" data-cost="${entry.cost}" data-free="${entry.cost === 0 ? 1 : 0}" aria-pressed="${chosen ? 'true' : 'false'}">
${art}
<span class="txt"><span class="nm">${escape(entry.name)}</span><span class="sub">${escape(sub)}</span></span>
<span class="pt">${escape(formatCost(entry.cost))}</span>
</button>`;
}

export function rosterShell(state: RosterShellState): string {
  const chosen = new Set(state.chosen);
  const spent = state.owned
    .filter((entry) => chosen.has(entry.id))
    .reduce((sum, entry) => sum + entry.cost, 0);

  const cards = state.owned.map((entry) => characterCard(entry, chosen.has(entry.id))).join('');

  return `<p class="eyebrow">${escape(state.tournamentName)}</p>
<h1>Мой состав</h1>
<p class="lede">Это твой аккаунт: ${state.owned.length} ${plural(state.owned.length)} с созвездиями,
оружием и ценой каждого. Выбери, с кем идёшь на турнир — ${state.limit} на этаж Бездны, четыре
на первую половину и четыре на вторую.${
    state.cap === null
      ? ' Потолка стоимости у этого турнира нет.'
      : ` Уложиться надо в ${escape(formatCost(state.cap))} очков.`
  }</p>

<div class="purse" id="purse">
  <span><span class="who">Набрано:</span> <b id="spent">${escape(formatCost(spent))}</b>${
    state.cap === null ? '' : ` <span class="who">из ${escape(formatCost(state.cap))}</span>`
  }</span>
  <span><span class="who">Персонажей:</span> <b id="count">${chosen.size}</b> <span class="who">из ${state.limit}</span></span>
  <span class="act">
    <button type="button" class="btn" id="save">Заявить состав</button>
    <button type="button" class="btn ghost" id="clear">Сбросить</button>
  </span>
</div>
<p class="said" id="said" role="status" aria-live="polite">${
    state.chosen.length > 0 ? 'Состав уже заявлен. Можно поменять и заявить снова.' : ''
  }</p>

${
    state.immunities === 0
      ? ''
      : `<section class="immune" id="immunebox">
  <h2>Иммуны — <span id="immunecount">${state.immune.length}</span> из ${state.immunities}</h2>
  <p class="hint">Иммунного персонажа соперник забанить не сможет. Взять его при этом может кто
  угодно: иммун защищает от бана, а не присваивает. Отмечать можно только заявленных.</p>
  <div class="chips" id="chips"></div>
</section>`
  }

<input class="filter" id="find" placeholder="Поиск по имени" autocomplete="off" aria-label="Поиск персонажа">
<div class="roster" id="roster">${cards}</div>

<p class="lede" style="margin-top:1.4rem">Очки считаются по системе турниров сообщества:
четырёхзвёздочные бесплатны совсем, лимитированный пятизвёздочный C0 стоит 1 и каждое созвездие
добавляет ещё 1, его сигнатурное оружие R1 — тоже 1. Артефакты не стоят ничего: они фармятся
временем, а не деньгами.</p>

<script>window.__ROSTER__=${JSON.stringify({ cap: state.cap, limit: state.limit, chosen: state.chosen, immunities: state.immunities, immune: state.immune }).replaceAll('<', '\\u003c')}</script>
<script>${SCRIPT}</script>`;
}

function plural(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return 'персонажей';
  switch (count % 10) {
    case 1:
      return 'персонаж';
    case 2:
    case 3:
    case 4:
      return 'персонажа';
    default:
      return 'персонажей';
  }
}

/**
 * Скрипт страницы. Считает набранное, гасит то, что уже не влезает, и отправляет заявку.
 * Правил про турнир здесь нет: потолок и предел состава приходят с сервера и им же проверяются
 * — иначе две копии правил однажды разойдутся, и страница пообещает то, чего сервер не примет.
 */
const SCRIPT = String.raw`
(function () {
  var conf = window.__ROSTER__;
  var token = location.pathname.split('/').pop();
  var el = function (id) { return document.getElementById(id); };
  var chosen = new Set(conf.chosen || []);
  var immune = new Set(conf.immune || []);

  function cards() { return Array.prototype.slice.call(document.querySelectorAll('.who4')); }

  function spent() {
    return cards().reduce(function (sum, card) {
      return chosen.has(card.dataset.id) ? sum + Number(card.dataset.cost || 0) : sum;
    }, 0);
  }

  function paint() {
    var total = Math.round(spent() * 10) / 10;
    var left = conf.cap === null ? Infinity : conf.cap - total;
    var full = chosen.size >= conf.limit;

    el('spent').textContent = String(total);
    el('count').textContent = String(chosen.size);
    el('purse').className = 'purse' + (conf.cap !== null && total > conf.cap ? ' over' : '');

    cards().forEach(function (card) {
      var picked = chosen.has(card.dataset.id);
      card.setAttribute('aria-pressed', picked ? 'true' : 'false');
      // Приглушаем то, что уже не влезет: по деньгам или по числу. Нажать по-прежнему можно —
      // сначала уберёшь кого-то, потом возьмёшь этого.
      var tooDear = !picked && (Number(card.dataset.cost || 0) > left || full);
      card.classList.toggle('too', tooDear);
    });

    el('save').disabled = chosen.size === 0 || (conf.cap !== null && total > conf.cap);
    paintImmune();
  }

  /**
   * Иммуны показываются только среди заявленных: защищать того, кого не берёшь, бессмысленно.
   * Убрали персонажа из состава — снимается и его иммун, иначе он остался бы висеть невидимкой.
   */
  function paintImmune() {
    var box = el('immunebox');
    if (!box) return;

    Array.from(immune).forEach(function (id) { if (!chosen.has(id)) immune.delete(id); });

    var names = {};
    cards().forEach(function (card) { names[card.dataset.id] = card.querySelector('.nm').textContent; });

    var list = Array.from(chosen);
    el('chips').innerHTML = list.length
      ? list.map(function (id) {
          return '<button type="button" class="chip" data-immune="' + id + '" aria-pressed="' +
            (immune.has(id) ? 'true' : 'false') + '">' + (names[id] || id) + '</button>';
        }).join('')
      : '<span class="none">Сначала выбери персонажей — защищать пока некого.</span>';

    el('immunecount').textContent = String(immune.size);
    cards().forEach(function (card) {
      card.dataset.immune = immune.has(card.dataset.id) ? '1' : '0';
    });
  }

  document.addEventListener('click', function (event) {
    var card = event.target.closest('.who4');
    if (card) {
      var id = card.dataset.id;
      if (chosen.has(id)) chosen.delete(id);
      else if (chosen.size < conf.limit) chosen.add(id);
      else { say('Больше ' + conf.limit + ' на этаж не берут — сначала убери кого-нибудь.', 'err'); return; }
      say('');
      paint();
      return;
    }
    var chip = event.target.closest('[data-immune]');
    if (chip && chip.classList.contains('chip')) {
      var who = chip.dataset.immune;
      if (immune.has(who)) immune.delete(who);
      else if (immune.size < conf.immunities) immune.add(who);
      else { say('Иммунов можно ' + conf.immunities + ' — сначала сними с кого-нибудь.', 'err'); return; }
      say('');
      paintImmune();
      return;
    }
    if (event.target.closest('#clear')) { chosen.clear(); immune.clear(); say(''); paint(); return; }
    if (event.target.closest('#save')) { submit(); }
  });

  el('find').addEventListener('input', function () {
    var needle = el('find').value.trim().toLowerCase();
    cards().forEach(function (card) {
      var name = (card.querySelector('.nm').textContent || '').toLowerCase();
      card.hidden = needle !== '' && name.indexOf(needle) < 0;
    });
  });

  function say(text, kind) {
    var node = el('said');
    node.textContent = text;
    node.dataset.kind = kind || '';
  }

  function submit() {
    el('save').disabled = true;
    say('Отправляю…', '');
    fetch('/api/roster/' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ characterIds: Array.from(chosen), immuneIds: Array.from(immune) }),
    })
      .then(function (r) { return r.json().catch(function () { return { error: 'Сервер ответил непонятно.' }; }); })
      .catch(function () { return { error: 'Не дозвонился до сервера. Проверь связь.' }; })
      .then(function (data) {
        paint();
        if (data.error) { say(data.error, 'err'); return; }
        var tail = data.immune ? ', иммунов ' + data.immune : '';
        say('Состав заявлен: ' + data.count + ' на ' + data.spent + ' очков' + tail + '. Поменять можно до старта.', 'ok');
      });
  }

  paint();
})();
`;

/** Страница отказа: у неё столько же поводов появиться, сколько шагов до заявки. */
export function rosterDenied(reason: string): string {
  return `<p class="eyebrow">Мой состав</p>
<h1>Пока не выйдет</h1>
<p class="lede">${escape(reason)}</p>`;
}
