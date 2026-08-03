/**
 * Оформление витрины: токены и правила целиком, одним листом.
 *
 * Визуальный язык взят из двух мест. Первое — ранговые медали: отсюда латунный акцент вместо
 * кислотного, тёплый цвет текста поверх холодного фона и моноширинный шрифт для всего, что
 * является данными. Второе — графика турнирной трансляции: полоса игрового арта над
 * заголовком, надзаголовок над именем и акцентная риска под ним.
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
 * Шрифт системный, своего не подключается. Дело не в лени: файл шрифта пришлось бы отдавать
 * отдельным маршрутом и копировать в образ, то есть добавить к сборке ещё один способ
 * не доехать до сервера. Характер здесь несут размер, начертание и разрядка, а не гарнитура.
 */

/** Геометрия сетки. Считается на сервере, поэтому размеры нужны и коду, и стилям. */
export const MATCH_H = 58;
export const V_GAP = 12;
export const PITCH = MATCH_H + V_GAP;
export const COL_W = 208;
export const LINK_W = 44;

export const STYLE = `
:root {
  --ink:#131119; --ink-2:#0c0a10; --sheet:#1b1922; --sheet-2:#232029; --rule:#332e42;
  --bone:#ece7dd; --dim:#9b93a8; --brass:#d9a544; --ember:#e2543a;
  /* Акцент дисциплины. Латунь — значение для страниц, которые не про одну игру. */
  --accent:#d9a544;
  /* Две стороны драфта: тёплая и холодная. Различимы и по цвету, и по светлоте — на одном
     тоне их не различил бы человек, который не различает красное и зелёное. */
  --side-a:#d9a544; --side-b:#59a5d8;
  --mono: ui-monospace,'SF Mono','Cascadia Mono','JetBrains Mono',Consolas,'Liberation Mono',monospace;
  --sans: ui-sans-serif,system-ui,-apple-system,'Segoe UI Variable Display','Segoe UI',Roboto,sans-serif;
  --match-h:${MATCH_H}px; --pitch:${PITCH}px; --col-w:${COL_W}px; --link-w:${LINK_W}px;
  --ease:cubic-bezier(.2,.7,.3,1);
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
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

/* ── Полоса игрового арта ───────────────────────────────────────────────────────────────
   Не украшение, а опознавательный знак: по ней видно, чья это дисциплина, до чтения
   заголовка. Обесцвечена и тонирована акцентом — см. правило для картинок выше. */
.band { display:flex; gap:2px; height:clamp(76px,14vw,128px); overflow:hidden;
  background:var(--ink-2); border-bottom:1px solid var(--rule); }
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

.wrap { max-width:76rem; margin:0 auto; padding:1.35rem 1.15rem 4rem; }

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
h1 { font-size:clamp(2rem,6vw,3.3rem); line-height:.98; margin:0 0 .55rem;
  font-weight:800; letter-spacing:-.035em; text-transform:uppercase;
  animation:enter .5s var(--ease) .04s both; }
h2 { font-family:var(--mono); font-size:.76rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--dim); font-weight:500; margin:2.4rem 0 .9rem;
  animation:enter .45s var(--ease) both; }
/* Акцентная риска у заголовка раздела уезжает вправо: раздел начинается, а не просто есть. */
h2::after { content:''; display:block; width:2.2rem; height:1px; background:var(--accent); margin-top:.5rem;
  transform-origin:left; animation:swipe .55s var(--ease) .1s both; }
@keyframes swipe { from { transform:scaleX(0); } to { transform:scaleX(1); } }
h3 { margin:0 0 .2rem; font-size:1.45rem; letter-spacing:-.02em; text-transform:uppercase; }
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
  text-transform:uppercase; color:var(--dim); border:1px solid var(--rule);
  border-radius:2px; padding:.2rem .5rem; }

/* ── Карточка турнира ───────────────────────────────────────────────────────────────────
   Слева картинка дисциплины, справа данные. Акцентная риска у края уезжает вниз при
   наведении: карточка отвечает на курсор, но не подпрыгивает. */
.card { position:relative; display:grid; grid-template-columns:auto 1fr; align-items:center; gap:1rem;
  background:var(--sheet); border:1px solid var(--rule); border-radius:3px; overflow:hidden;
  padding:.85rem 1.15rem .85rem 1.25rem; margin-bottom:.7rem;
  transition:border-color .2s, transform .2s;
  animation:enter .42s var(--ease) both; animation-delay:var(--delay,0ms); }
.card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:var(--accent); transform:scaleY(.28); transform-origin:top; transition:transform .28s ease; }
.card:hover, .card:focus-visible { border-color:var(--accent); transform:translateX(2px); }
.card:hover::before, .card:focus-visible::before { transform:scaleY(1); }
.card .sig { width:58px; height:58px; border-radius:2px; overflow:hidden; flex:0 0 auto;
  background:var(--sheet-2); isolation:isolate; position:relative; }
.card .sig img { width:100%; height:100%; object-fit:cover; filter:grayscale(1) brightness(.72) contrast(1.1);
  transition:filter .3s, transform .4s var(--ease); }
.card .sig::after { content:''; position:absolute; inset:0; background:var(--accent);
  mix-blend-mode:color; opacity:.5; transition:opacity .3s; }
/* Наведение возвращает картинке цвет: карточка становится тем, куда ведёт. */
.card:hover .sig img { filter:none; transform:scale(1.08); }
.card:hover .sig::after { opacity:0; }
/* display:block обязателен: внутри карточки это span-ы, а строчные элементы встали бы в одну
   строку — название, данные и состояние слиплись бы в кашу. */
.card .name { display:block; font-size:1.1rem; font-weight:700; letter-spacing:-.015em; }
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
  background:var(--sheet); border:1px solid var(--rule); border-radius:3px; overflow:hidden;
  opacity:0; transform:translateY(6px); animation:rise .42s ease-out forwards;
  animation-delay:var(--delay); transition:border-color .18s, box-shadow .18s; }
@keyframes rise { to { opacity:1; transform:none; } }
.m:hover { border-color:var(--accent); box-shadow:0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
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
.medal::before { content:''; width:9px; height:9px; border-radius:2px; transform:rotate(45deg);
  background:var(--tc); box-shadow:0 0 8px -1px var(--tc); flex:0 0 auto; }
td.num { text-align:right; color:var(--dim); font-variant-numeric:tabular-nums; }
td.acct a { border-bottom:1px solid transparent; transition:color .18s, border-color .18s; }
td.acct a:hover, td.acct a:focus-visible { color:var(--accent); border-color:var(--accent); }
/* Чемпион — единственная строка таблицы, которой позволено быть акцентной. */
td.champ { color:var(--accent); font-weight:600; }
/* «Заявлено» намеренно тихое: это оговорка к рангу, а не его часть. */
.claimed { font-family:var(--mono); font-size:.62rem; letter-spacing:.1em; text-transform:uppercase;
  color:var(--dim); border:1px solid var(--rule); border-radius:2px; padding:.1rem .3rem;
  margin-left:.45rem; white-space:nowrap; }

/* ── Пьедестал ──────────────────────────────────────────────────────────────────────────
   Место обозначено крупной цифрой, а не медалью: цифра — это и есть место, и она читается
   на любом размере экрана. Чемпион крупнее и акцентный, остальные ровно настолько, чтобы
   читались как места, а не как утешение. */
.podium { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));
  margin-bottom:.5rem; }
.pl { position:relative; display:grid; grid-template-columns:auto 1fr; grid-template-rows:auto auto;
  gap:.05rem .85rem; align-items:center; background:var(--sheet); border:1px solid var(--rule);
  border-radius:3px; padding:.95rem 1.1rem; overflow:hidden;
  animation:enter .45s var(--ease) both; animation-delay:var(--delay,0ms); }
.pl.first { border-color:var(--accent); box-shadow:0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent); }
.pl .mk { grid-row:1 / span 2; font-family:var(--mono); font-size:2.4rem; line-height:.85;
  font-weight:700; color:var(--rule); font-variant-numeric:tabular-nums; }
.pl.first .mk { color:var(--accent); font-size:3rem; }
.pl .who { font-weight:700; font-size:1.05rem; letter-spacing:-.015em; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.pl.first .who { color:var(--accent); font-size:1.25rem; }
.pl .pn { font-family:var(--mono); font-size:.66rem; letter-spacing:.18em; text-transform:uppercase;
  color:var(--dim); }

.empty { border:1px dashed var(--rule); border-radius:3px; padding:2rem 1.25rem; text-align:center; }
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
