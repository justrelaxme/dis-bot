/**
 * Оформление витрины: токены и правила целиком, одним листом.
 *
 * Направление — интерфейс игрового клиента. Отсюда три решения. Панели со срезанным углом
 * вместо скруглений: одна система формы на весь сайт, и она же подпись оформления. Холодная
 * сине-стальная гамма: тёплая пара «латунь плюс сливочный» ушла намеренно — это набор, который
 * выдаёт машинная вёрстка, а не выбор под задачу. Моноширинный шрифт для всего, что является
 * данными: имена в сетке выстраиваются в колонки, как на настоящем турнирном листе.
 *
 * Плотность здесь высокая осознанно. Это табло, а не афиша: сто двадцать семь плиток героев,
 * сетка на восемь команд и таблица рангов должны быть видны, а не разложены по экранам.
 *
 * **Акцент задаёт дисциплина, а не таблица стилей.** На корне страницы стоит `--accent`, и от
 * него зависит всё выделенное: рамки, риски, полосы, ссылки. Одна переменная вместо четырёх
 * наборов правил — иначе четыре дисциплины означали бы четыре стиля, которые расходятся при
 * первой же правке. Значения живут в `art.ts`, рядом с картинками той же игры.
 *
 * **Правило для картинок:** то, о чём принимают решение, показывается честным цветом; то, что
 * является фоном, обесцвечивается и тонируется акцентом. Поэтому карта в вето — цветная
 * фотография, а та же карта в полосе шапки — монохромный силуэт. Иначе шапка спорила бы за
 * внимание с тем, ради чего страницу открыли.
 *
 * Три роли шрифта. Заголовки набраны своей гарнитурой (Unbounded, вшита в `font.ts`) —
 * системный шрифт делает страницу похожей на любую другую, а заголовок это единственное место,
 * где характер виден сразу. Данные — моноширинным: имена в сетке выстраиваются в колонки, как
 * на настоящем турнирном листе. Всё остальное — системным, потому что читать его надо, а не
 * рассматривать.
 */

import { FONT_FACE } from './font.js';

/** Геометрия сетки. Считается на сервере, поэтому размеры нужны и коду, и стилям. */
export const MATCH_H = 58;
export const V_GAP = 12;
export const PITCH = MATCH_H + V_GAP;
export const COL_W = 208;
export const LINK_W = 44;

export const STYLE = `
${FONT_FACE}
:root {
  /* Холодная гамма. Тёплая пара «латунь плюс сливочный» ушла намеренно: это ровно тот набор,
     который выдаёт машинная вёрстка, а не выбор под задачу. Здесь табло игрового сервера, и
     холодный сине-стальной ряд ему честнее — он же и не спорит с цветами самих игр. */
  --ink:#101319; --ink-2:#090b0f; --sheet:#171b23; --sheet-2:#1e232d; --rule:#2b3342;
  --bone:#e6ebf2; --dim:#8d97a8; --ember:#e2543a;
  /**
   * Акцент дисциплины. Холодная бирюза — значение для страниц, которые не про одну игру.
   * Цвета самих игр (красный Valorant, оранжевый Dota, золото LoL) остаются их собственными:
   * это опознавательные знаки, а не палитра, выбранная за них.
   */
  --accent:#3fd4e8;
  /* Две стороны драфта. Различимы и по цвету, и по светлоте — на одном тоне их не различил бы
     человек, который не различает красное и зелёное. */
  --side-a:#f0a93c; --side-b:#59a5d8;
  --mono: ui-monospace,'SF Mono','Cascadia Mono','JetBrains Mono',Consolas,'Liberation Mono',monospace;
  --sans: ui-sans-serif,system-ui,-apple-system,'Segoe UI Variable Display','Segoe UI',Roboto,sans-serif;
  /**
   * Гарнитура заголовков. Отдельная роль, а не «то же, но крупнее»: системный шрифт делает
   * страницу похожей на любую другую, а заголовок — единственное место, где характер виден
   * сразу. Подключена в font.ts и вшита туда же, поэтому падение сети её не уносит.
   */
  --display: 'Unbounded', var(--sans);
  --match-h:${MATCH_H}px; --pitch:${PITCH}px; --col-w:${COL_W}px; --link-w:${LINK_W}px;
  --ease:cubic-bezier(.2,.7,.3,1);
  /* Тень тонирована фоном: чистое чёрное на синеватой поверхности читается грязным пятном. */
  --shadow: 0 10px 26px -14px rgba(6,10,18,.9);
  /**
   * Одна система углов на весь сайт: прямые углы со срезом наискось. Это и есть подпись
   * оформления, взятая у интерфейсов самих игр, — и она же закрывает требование единой формы,
   * потому что скруглений здесь нет вообще, а не «где 2 пикселя, где 3».
   */
  --cut:10px;
  --panel: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
body {
  margin:0; background:var(--ink); color:var(--bone); font-family:var(--sans);
  font-size:16px; line-height:1.5;
  background-image:
    radial-gradient(1200px 460px at 84% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 64%),
    radial-gradient(820px 400px at 6% 106%, rgba(226,84,58,.06), transparent 62%);
  background-attachment:fixed;
}
a { color:inherit; text-decoration:none; }
img { max-width:100%; }

/**
 * Зерно поверх всего. Ровный цвет читается как незаполненный, а не как выбранный: плотность
 * поверхности даёт именно шум. Слой не перехватывает курсор и не попадает в поток, поэтому
 * ни на разметку, ни на нажатия не влияет.
 */
body::after {
  content:''; position:fixed; inset:0; z-index:9; pointer-events:none; opacity:.035;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}
/**
 * Ссылка для тех, кто ходит с клавиатуры: без неё до содержимого надо протабать всю навигацию.
 * Имя класса не «skip» намеренно: оно уже занято кнопкой «Пропустить бан» на странице драфта,
 * и совпадение увело бы ту кнопку за край экрана. Обратные кавычки внутри этой таблицы стилей
 * тоже нельзя — она сама шаблонная строка, и они её закрывают.
 */
.skiplink { position:absolute; left:-999px; top:0; z-index:20; background:var(--sheet);
  border:1px solid var(--accent); color:var(--bone); padding:.5rem .8rem; font-family:var(--mono);
  font-size:.8rem; }
.skiplink:focus { left:.6rem; top:.6rem; }

/* ── Полоса игрового арта ───────────────────────────────────────────────────────────────
   Не украшение, а опознавательный знак: по ней видно, чья это дисциплина, до чтения
   заголовка. Обесцвечена и тонирована акцентом — см. правило для картинок выше. */
.band { display:flex; gap:2px; height:clamp(140px,24vw,260px); overflow:hidden;
  background:var(--ink-2); }
.band figure { position:relative; flex:1 1 0; margin:0; overflow:hidden; isolation:isolate;
  clip-path:inset(0 0 100% 0); animation:wipe .5s var(--ease) both; animation-delay:var(--delay,0ms); }
/* Кадр берётся выше середины: у портретов там лицо, у карт — постройки, а не небо. */
.band img { width:100%; height:100%; object-fit:cover; object-position:center 38%;
  filter:grayscale(1) contrast(1.12) brightness(.58); transform:scale(1.06);
  animation:settle 1.1s var(--ease) both; animation-delay:var(--delay,0ms); }
.band figure::before { content:''; position:absolute; inset:0; background:var(--accent);
  mix-blend-mode:color; opacity:.55; }
.band figure::after { content:''; position:absolute; inset:0;
  background:linear-gradient(180deg,rgba(19,17,25,0) 34%,var(--ink) 100%); }
/* Полоса уезжает вниз шторкой, картинка внутри осаживается — одно движение при загрузке. */
@keyframes wipe { to { clip-path:inset(0); } }
@keyframes settle { to { transform:scale(1); } }
/* На узком экране лишние панели убираются: шесть картинок по 50 пикселей — не полоса, а рябь. */
@media (max-width:720px) { .band figure:nth-child(n+4) { display:none; } }
@media (max-width:420px) { .band figure:nth-child(n+3) { display:none; } }

/**
 * Содержимое заходит на полосу арта снизу. Раньше полоса и заголовок стояли раздельно, и
 * страница читалась двумя не связанными кусками; наложение делает из них одно целое — тот же
 * приём, что в нижней плашке трансляции, где имя лежит поверх картинки.
 *
 * Полоса гаснет к низу до цвета фона, поэтому текст поверх неё остаётся читаемым без подложки.
 */
.wrap { max-width:76rem; margin:calc(-1 * clamp(3rem,7vw,6.5rem)) auto 0; padding:1.35rem 1.15rem 4rem;
  position:relative; z-index:1; }

/* Шапка: полоса состояния, а не украшение — она показывает, что происходит сейчас. */
.top { display:flex; align-items:baseline; gap:1.25rem; flex-wrap:wrap; padding-bottom:.9rem;
  border-bottom:1px solid var(--rule); margin-bottom:1.6rem; }
.mark { font-family:var(--mono); font-size:.72rem; letter-spacing:.24em; text-transform:uppercase;
  color:var(--accent); }
.top nav { display:flex; gap:1.1rem; margin-left:auto; font-family:var(--mono); font-size:.76rem;
  letter-spacing:.1em; text-transform:uppercase; color:var(--dim); flex-wrap:wrap; }
.top nav a { padding-bottom:2px; border-bottom:1px solid transparent; transition:color .18s, border-color .18s; }
.top nav a:hover, .top nav a:focus-visible { color:var(--bone); border-color:var(--accent); }
.top nav a[aria-current] { color:var(--bone); border-color:var(--accent); }

/* Вход элементов на страницу. Одно движение, короткое и в одну сторону: страница должна
   собираться на глазах, а не устраивать представление. Главный движок здесь — линии сетки
   и полотно драфта, и всё остальное обязано им уступать. */
@keyframes enter { from { opacity:0; transform:translateY(9px); } to { opacity:1; transform:none; } }

/* Надзаголовок: дисциплина и формат до имени турнира. Тот же приём, что в нижней плашке
   трансляции, — сначала «что это», потом «как называется». */
.eyebrow { font-family:var(--mono); font-size:.7rem; letter-spacing:.26em; text-transform:uppercase;
  color:var(--accent); margin:0 0 .5rem; animation:enter .45s var(--ease) both; }
h1 { font-family:var(--display); font-size:clamp(1.7rem,5vw,2.9rem); line-height:1.04;
  margin:0 0 .6rem; font-weight:800; letter-spacing:-.045em; text-transform:uppercase;
  text-wrap:balance; animation:enter .5s var(--ease) .04s both; }
h2 { font-family:var(--mono); font-size:.76rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--dim); font-weight:500; margin:2.4rem 0 .9rem;
  animation:enter .45s var(--ease) both; }
/* Акцентная риска у заголовка раздела уезжает вправо: раздел начинается, а не просто есть. */
h2::after { content:''; display:block; width:2.2rem; height:1px; background:var(--accent); margin-top:.5rem;
  transform-origin:left; animation:swipe .55s var(--ease) .1s both; }
@keyframes swipe { from { transform:scaleX(0); } to { transform:scaleX(1); } }
h3 { font-family:var(--display); margin:0 0 .3rem; font-size:1.25rem; letter-spacing:-.04em;
  text-transform:uppercase; font-weight:700; }
.lede { color:var(--dim); font-size:.95rem; margin:0 0 1.5rem; max-width:56ch;
  animation:enter .5s var(--ease) .08s both; }
.mono { font-family:var(--mono); }
.dim { color:var(--dim); }

/* Точка «идёт сейчас» пульсирует — единственный постоянный движок на странице. */
.live { display:inline-flex; align-items:center; gap:.45rem; font-family:var(--mono);
  font-size:.7rem; letter-spacing:.16em; text-transform:uppercase; color:var(--ember); }
.live::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--ember);
  box-shadow:0 0 0 0 rgba(226,84,58,.55); animation:pulse 2s ease-out infinite; }
@keyframes pulse { 70%{box-shadow:0 0 0 9px rgba(226,84,58,0);} 100%{box-shadow:0 0 0 0 rgba(226,84,58,0);} }

.chip { display:inline-block; font-family:var(--mono); font-size:.68rem; letter-spacing:.14em;
  text-transform:uppercase; color:var(--dim); border:1px solid var(--rule); padding:.2rem .5rem; }

/* ── Карточка турнира ───────────────────────────────────────────────────────────────────
   Слева картинка дисциплины, справа данные. Акцентная риска у края уезжает вниз при
   наведении: карточка отвечает на курсор, но не подпрыгивает. */
.card { position:relative; display:grid; grid-template-columns:auto 1fr; align-items:center; gap:1rem;
  background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel); overflow:hidden;
  padding:.85rem 1.15rem .85rem 1.25rem; margin-bottom:.7rem;
  transition:border-color .2s, transform .2s;
  animation:enter .42s var(--ease) both; animation-delay:var(--delay,0ms); }
/* Метка дисциплины: её цвет, а не акцент страницы. Растёт при наведении. */
.card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:var(--mark,var(--accent)); transform:scaleY(.28); transform-origin:top;
  transition:transform .28s ease; }
.card:hover, .card:focus-visible { border-color:var(--accent); transform:translateX(2px); }
.card:active { transform:translateX(2px) scale(.995); }
.card:hover::before, .card:focus-visible::before { transform:scaleY(1); }
.card .sig { width:58px; height:58px; overflow:hidden; flex:0 0 auto;
  background:var(--sheet-2); isolation:isolate; position:relative; }
.card .sig img { width:100%; height:100%; object-fit:cover; filter:grayscale(1) brightness(.72) contrast(1.1);
  transition:filter .3s, transform .4s var(--ease); }
.card .sig::after { content:''; position:absolute; inset:0; background:var(--mark,var(--accent));
  mix-blend-mode:color; opacity:.5; transition:opacity .3s; }
/* Наведение возвращает картинке цвет: карточка становится тем, куда ведёт. */
.card:hover .sig img { filter:none; transform:scale(1.08); }
.card:hover .sig::after { opacity:0; }
/* display:block обязателен: внутри карточки это span-ы, а строчные элементы встали бы в одну
   строку — название, данные и состояние слиплись бы в кашу. */
.card .name { display:block; font-family:var(--display); font-size:1.02rem; font-weight:700;
  letter-spacing:-.04em; text-transform:uppercase; }
.card .meta { display:block; color:var(--dim); font-size:.84rem; margin-top:.2rem; font-family:var(--mono); }
.card .tail { display:block; margin-top:.5rem; }
@media (max-width:520px) { .card .sig { display:none; } .card { grid-template-columns:1fr; } }

/* ── Сетка ──────────────────────────────────────────────────────────────────────────────
   Колонки и связи позиционируются по точной геометрии, посчитанной на сервере. */
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
  background:var(--sheet); border:1px solid var(--rule); clip-path:var(--panel); overflow:hidden;
  opacity:0; transform:translateY(6px); animation:rise .42s ease-out forwards;
  animation-delay:var(--delay); transition:border-color .18s, box-shadow .18s; }
@keyframes rise { to { opacity:1; transform:none; } }
.m:hover { border-color:var(--accent); }
.m.live-m { border-color:rgba(226,84,58,.5); }
/* Матч, который не состоится: место под проигравшего, которого не случилось. Оставлен
   в сетке нарочно — без него в ней была бы дыра, а дыра читается как ошибка. */
.m.dead-m { opacity:.32; border-style:dashed; }
.m .s { display:flex; align-items:center; justify-content:space-between; gap:.5rem;
  height:calc(var(--match-h)/2 - 1px); padding:0 .6rem; font-family:var(--mono); font-size:.82rem; }
.m .s + .s { border-top:1px solid var(--rule); }
.m .s .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Справа стоит счёт или слово о состоянии. Цифры табличные и крупнее слов: в сетке за ними
   и приходят, а колонки счёта не должны дёргаться от разной ширины знаков. */
.m .s .sd { color:var(--dim); font-size:.78rem; font-variant-numeric:tabular-nums; }
.m .s.won { color:var(--accent); }
.m .s.won .sd { color:var(--accent); }
.m .s.tbd { color:var(--dim); }
.m .seed { color:var(--dim); font-size:.68rem; margin-right:.4rem; }

/* ── Таблицы: лидерборд и летопись ──────────────────────────────────────────────────── */
.scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
table { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:.88rem; }
thead th { text-align:left; padding:.5rem .5rem .6rem; border-bottom:1px solid var(--rule);
  color:var(--dim); font-weight:500; font-size:.68rem; letter-spacing:.16em; text-transform:uppercase;
  white-space:nowrap; }
tbody td { padding:.62rem .5rem; border-bottom:1px solid rgba(51,46,66,.6); }
tbody tr { animation:rise .3s ease-out backwards; animation-delay:var(--delay); }
tbody tr:hover td { background:var(--sheet-2); }
/* Место — крупная цифра: в таблице рангов номер и есть то, за чем в неё смотрят. */
td.pos { color:var(--dim); text-align:right; width:3rem; font-size:1.05rem;
  font-variant-numeric:tabular-nums; }
tbody tr:nth-child(-n+3) td.pos { color:var(--accent); }
td.acct { font-family:var(--sans); font-weight:600; }
.medal { display:inline-flex; align-items:center; gap:.5rem; white-space:nowrap; }
.medal::before { content:''; width:9px; height:9px; transform:rotate(45deg);
  background:var(--tc); flex:0 0 auto; }
td.num { text-align:right; color:var(--dim); font-variant-numeric:tabular-nums; }
td.acct a { border-bottom:1px solid transparent; transition:color .18s, border-color .18s; }
td.acct a:hover, td.acct a:focus-visible { color:var(--accent); border-color:var(--accent); }
/* Чемпион — единственная строка таблицы, которой позволено быть акцентной. */
td.champ { color:var(--accent); font-weight:600; }
/* «Заявлено» намеренно тихое: это оговорка к рангу, а не его часть. */
.claimed { font-family:var(--mono); font-size:.62rem; letter-spacing:.1em; text-transform:uppercase;
  color:var(--dim); border:1px solid var(--rule); padding:.1rem .3rem;
  margin-left:.45rem; white-space:nowrap; }

/* ── Пьедестал ──────────────────────────────────────────────────────────────────────────
   Место обозначено крупной цифрой, а не медалью: цифра — это и есть место, и она читается
   на любом размере экрана. Чемпион крупнее и акцентный, остальные ровно настолько, чтобы
   читались как места, а не как утешение. */
.podium { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));
  margin-bottom:.5rem; }
.pl { position:relative; display:grid; grid-template-columns:auto 1fr; grid-template-rows:auto auto;
  gap:.05rem .85rem; align-items:center; background:var(--sheet); border:1px solid var(--rule);
  clip-path:var(--panel); padding:.95rem 1.1rem; overflow:hidden;
  animation:enter .45s var(--ease) both; animation-delay:var(--delay,0ms); }
.pl.first { border-color:var(--accent); }
.pl .mk { grid-row:1 / span 2; font-family:var(--mono); font-size:2.4rem; line-height:.85;
  font-weight:700; color:var(--rule); font-variant-numeric:tabular-nums; }
.pl.first .mk { color:var(--accent); font-size:3rem; }
.pl .who { font-weight:700; font-size:1.05rem; letter-spacing:-.015em; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
/* Чемпион — своей гарнитурой: единственное имя на странице, которое надо запомнить. */
.pl.first .who { font-family:var(--display); color:var(--accent); font-size:1.3rem;
  letter-spacing:-.04em; text-transform:uppercase; }
.pl .pn { font-family:var(--mono); font-size:.66rem; letter-spacing:.18em; text-transform:uppercase;
  color:var(--dim); }

.empty { border:1px dashed var(--rule); padding:2rem 1.25rem; text-align:center; }
.empty p { margin:.35rem 0; color:var(--dim); }
.empty code, code.k { font-family:var(--mono); color:var(--accent); }

footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--rule);
  color:var(--dim); font-size:.78rem; font-family:var(--mono); }
footer p { margin:.3rem 0; }
/* Подпись к картинкам обязательна: это чужие изображения, и молчать о том, чьи они, нельзя. */
.credit { color:var(--rule); }

:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (max-width:640px) { :root { --col-w:170px; --link-w:30px; } .wrap { padding:1.15rem .85rem 3rem; } }

@media (prefers-reduced-motion:reduce) {
  html { scroll-behavior:auto; }
  .links path { animation:none; stroke-dashoffset:0; }
  /* Всё, что появляется движением, обязано просто быть — иначе анимация станет условием
     видимости, и человек с выключенным движением увидит пустую страницу. */
  .m, tbody tr, h1, h2, .eyebrow, .lede, .card, .fmt, .slot, .pl, .band figure, .band img, .tile {
    animation:none; opacity:1; transform:none; clip-path:none; }
  h2::after { animation:none; transform:none; }
  .live::before { animation:none; }
  * { transition:none !important; }
}
`;
