import { VALORANT_MAPS } from '../tournaments/draft/pools.js';
import { VALORANT_AGENT_FACES, dotaHeroArt } from './art.js';
import { escape } from './render.js';

/**
 * Правила. Не общие слова про киберспорт, а то, что бот действительно делает: сроки, на
 * которые он реагирует, действия, которые он принимает, и решения, которые принимает сам.
 *
 * Нумерация шагов здесь заслужена: попадание в турнир — это последовательность, и порядок
 * в ней несёт смысл. Отметиться до создания команды нельзя, а забанить карту до старта —
 * тем более. Где порядок не важен, номеров нет.
 *
 * Картинки на этой странице цветные, в отличие от полосы в шапке. Правило то же, что и
 * везде: страница объясняет, что именно делят перед матчем, — значит, показывать это надо
 * так, как игрок увидит в игре, а не силуэтом.
 */

export const RULES_STYLE = `
.formats { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));
  margin-bottom:2rem; }
.fmt { position:relative; background:var(--sheet); border:1px solid var(--rule); border-radius:3px;
  padding:1.35rem 1.35rem 1.5rem; overflow:hidden;
  opacity:0; transform:translateY(10px); animation:rise .5s ease-out forwards; animation-delay:var(--delay); }
.fmt::after { content:''; position:absolute; inset:0 0 auto; height:2px; background:var(--accent);
  transform:scaleX(0); transform-origin:left; transition:transform .45s ease; }
.fmt:hover::after { transform:scaleX(1); }
.fmt .who { font-family:var(--mono); font-size:.72rem; letter-spacing:.16em; text-transform:uppercase;
  color:var(--accent); margin-bottom:1rem; }

/* Нумерованные шаги: порядок здесь несёт смысл, поэтому номера видны. */
.steps { list-style:none; margin:0; padding:0; counter-reset:step; }
.steps li { position:relative; counter-increment:step; padding:0 0 .95rem 2.4rem; }
.steps li::before { content:counter(step,decimal-leading-zero); position:absolute; left:0; top:.05rem;
  font-family:var(--mono); font-size:.72rem; color:var(--accent); letter-spacing:.05em; }
.steps li::after { content:''; position:absolute; left:.45rem; top:1.3rem; bottom:.1rem; width:1px;
  background:var(--rule); }
.steps li:last-child { padding-bottom:0; }
.steps li:last-child::after { display:none; }
.steps b { color:var(--bone); }
.steps code, .rule code { font-family:var(--mono); font-size:.85em; color:var(--accent); }
.steps .sub { display:block; color:var(--dim); font-size:.88rem; margin-top:.15rem; }

.rule { display:grid; grid-template-columns:minmax(7rem,10rem) 1fr; gap:.4rem 1.1rem; padding:.85rem 0;
  border-bottom:1px solid rgba(51,46,66,.6); }
.rule:last-child { border-bottom:none; }
.rule dt { font-family:var(--mono); font-size:.74rem; letter-spacing:.1em; text-transform:uppercase;
  color:var(--dim); padding-top:.15rem; }
.rule dd { margin:0; }
@media (max-width:560px) { .rule { grid-template-columns:1fr; gap:.15rem; } }

.clock-line { display:flex; gap:.5rem; align-items:stretch; flex-wrap:wrap; margin:.5rem 0 2rem; }
.slot { flex:1 1 8rem; background:var(--sheet); border:1px solid var(--rule); border-radius:3px;
  padding:.8rem .9rem; opacity:0; animation:rise .45s ease-out forwards; animation-delay:var(--delay); }
.slot .t { font-family:var(--mono); font-size:1.15rem; color:var(--accent); }
.slot .d { color:var(--dim); font-size:.85rem; margin-top:.2rem; }

/* Что делят перед матчем. Цветные картинки: страница объясняет именно их. */
.divide { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));
  margin:.5rem 0 2rem; }
.pile { background:var(--sheet); border:1px solid var(--rule); border-radius:3px; padding:.9rem 1rem 1rem;
  opacity:0; animation:rise .45s ease-out forwards; animation-delay:var(--delay); }
.pile .h { font-family:var(--mono); font-size:.7rem; letter-spacing:.18em; text-transform:uppercase;
  color:var(--accent); }
.pile .d { color:var(--dim); font-size:.86rem; margin:.3rem 0 .7rem; }
.pile .row { display:flex; gap:.3rem; flex-wrap:wrap; }
.pile img { height:44px; width:auto; max-width:76px; object-fit:cover; border-radius:2px;
  border:1px solid var(--rule); background:var(--sheet-2);
  transition:transform .3s var(--ease), border-color .3s; }
.pile img:hover { transform:translateY(-3px) scale(1.04); border-color:var(--accent); }
`;

interface Step {
  text: string;
  sub?: string;
}

function steps(items: Step[]): string {
  return `<ol class="steps">${items
    .map((item) => `<li>${item.text}${item.sub ? `<span class="sub">${item.sub}</span>` : ''}</li>`)
    .join('')}</ol>`;
}

function rule(term: string, body: string): string {
  return `<div class="rule"><dt>${escape(term)}</dt><dd>${body}</dd></div>`;
}

function pile(
  index: number,
  heading: string,
  note: string,
  images: readonly string[],
): string {
  const row = images
    .filter(Boolean)
    .slice(0, 6)
    .map((src) => `<img src="${escape(src)}" alt="" loading="lazy" decoding="async">`)
    .join('');
  return `<div class="pile" style="--delay:${index * 70}ms">
<div class="h">${escape(heading)}</div>
<div class="d">${escape(note)}</div>
<div class="row">${row}</div>
</div>`;
}

/** Герои для картинки: узнаваемые, а не первые по алфавиту. Только для показа. */
const SHOWN_HEROES = ['pudge', 'invoker', 'juggernaut', 'crystal_maiden', 'axe'];

export function renderRules(): string {
  const day = [
    { t: '14:00', d: 'Голосование по дисциплине' },
    { t: '16:00', d: 'Итог голосования, открывается регистрация' },
    { t: '19:45', d: 'Напоминание тем, кто не отметился' },
    { t: '20:00', d: 'Регистрация закрыта, сетка построена' },
  ];

  return `<p class="eyebrow">Как это работает</p>
<h1>Правила</h1>
<p class="lede">Всё, что бот делает сам, и всё, что он ждёт от вас. Времена — по настройке сервера,
здесь показаны значения по умолчанию.</p>

<h2>День турнира</h2>
<div class="clock-line">
${day
  .map(
    (slot, index) =>
      `<div class="slot" style="--delay:${index * 70}ms"><div class="t">${slot.t}</div><div class="d">${escape(slot.d)}</div></div>`,
  )
  .join('')}
</div>

<h2>Что делят перед матчем</h2>
<p class="lede">Драфт открывается по ссылке из личных сообщений, ходят капитаны по очереди.
Всё, что выбрано, остаётся записью — переписать её задним числом нельзя.</p>
<div class="divide">
${pile(
  0,
  'Карты Valorant',
  'Банят по очереди, пока не останется одна. Её никто не выбирал — поэтому спорить не о чем.',
  VALORANT_MAPS.map((map) => map.imageUrl ?? ''),
)}
${pile(
  1,
  'Агенты Valorant',
  'По два бана и по пять пиков. Забаненного не берёт никто, а взятого соперником — можно.',
  VALORANT_AGENT_FACES,
)}
${pile(
  2,
  'Герои Dota',
  'Баны, потом пики змейкой. Чужой пик виден — под него берут контрпик.',
  SHOWN_HEROES.map(dotaHeroArt),
)}
</div>

<h2>Два формата</h2>
<div class="formats">
  <div class="fmt" style="--delay:60ms">
    <h3>5 на 5</h3>
    <div class="who">команды собираются сами</div>
    ${steps([
      {
        text: 'Привяжи игровой аккаунт — <code>/link</code>',
        sub: 'Один раз. Без привязки не будет ни ранга, ни роли, ни места в жеребьёвке.',
      },
      {
        text: 'Кто-то один жмёт <b>«Создать команду»</b> и вводит название — он капитан',
        sub: 'Остальные жмут «Найти команду» и выбирают, куда вступить. Приглашать никого не надо.',
      },
      {
        text: 'Капитан жмёт <b>«Я готов»</b> до старта',
        sub: 'Не отметились — в сетку не попадёте. Это правило одинаково для всех.',
      },
      {
        text: 'Бот раскладывает сетку и создаёт команде голосовой канал',
        sub: 'Соперника и ветку матча он назовёт сам.',
      },
      {
        text: 'Капитаны проходят драфт по ссылке из личных сообщений',
        sub: 'Dota — по два бана и по пять героев. Valorant — сначала карта, потом по два бана и по пять агентов.',
      },
      {
        text: 'После игры победитель пишет <code>/match report</code>',
        sub: 'Соперник подтверждает кнопкой. Молчит час — результат принимается сам.',
      },
    ])}
  </div>

  <div class="fmt" style="--delay:140ms">
    <h3>1 на 1</h3>
    <div class="who">каждый сам за себя, способности включены</div>
    ${steps([
      {
        text: 'Привяжи игровой аккаунт — <code>/link</code>',
        sub: 'То же, что и в командном: ранг нужен жеребьёвке.',
      },
      {
        text: 'Жми <b>«Записаться»</b> под объявлением',
        sub: 'Команду собирать не надо — участник это ты сам.',
      },
      {
        text: 'Жми <b>«Я готов»</b> до старта',
        sub: 'Чек-ин обязателен и здесь.',
      },
      {
        text: 'Сетка сводит игроков попарно',
        sub: 'Соперник придёт из той же жеребьёвки по рангу.',
      },
      {
        text: 'Драфт короче: по одному бану и по одному пику',
        sub: 'В Dota это мид 1×1, в Valorant — дуэль на решающей карте выбранным агентом. Если организатор выключил способности, драфта не будет вовсе: там решает только прицел.',
      },
      {
        text: 'После игры — <code>/match report</code>',
        sub: 'Дальше всё как в командном.',
      },
    ])}
  </div>
</div>

<h2>Как бот решает спорные вещи</h2>
<dl style="margin:0">
${rule('Жеребьёвка', 'По <b>средней</b> силе состава из рангов привязок. Команда с одним сильным игроком не забирает пропуск незаслуженно, а первый со вторым сеяным встречаются не раньше финала.')}
${rule('Пропуски', 'В неполной сетке достаются старшим сеяным. Пропуск — преимущество, и оно идёт тому, кто заслужил его силой.')}
${rule('Сетка', 'Двойное устранение: проигравший падает в нижнюю сетку и может дойти до финала оттуда, выбывание — со второго поражения. У ежедневного турнира по умолчанию выбывание с первого: двойное примерно удваивает длину вечера.')}
${rule('Молчание', 'Соперник не подтверждает результат час — результат принимается. Иначе один неотвечающий игрок останавливал бы всю сетку.')}
${rule('Спор', 'Кнопка «Не так было» переводит матч к организатору: <code>/match resolve</code>. Бот сам ничего не решает.')}
${rule('Неявка', 'Организатор присуждает победу без игры: <code>/match walkover</code>.')}
${rule('Замены', 'Капитан меняет состав <code>/team add</code> и <code>/team kick</code> — в том числе во время турнира. Сетка сводит команды, а не людей, поэтому замена ей не мешает.')}
${rule('Ход драфта', 'Минута. Не успел — бан пропускается, а пик берётся первым свободным: иначе драфт остановился бы навсегда. Первый, а не случайный, потому что случайность в необратимом действии нельзя ни проверить, ни объяснить.')}
${rule('Дуэль на прицел', 'У турнира можно выключить способности — <code>abilities:false</code> при создании. Тогда драфта нет <b>вовсе</b>: ни агентов, ни карты. Играют на любом агенте, и решает только стрельба, поэтому делить нечего, а заставлять капитанов нажимать кнопки без причины незачем. Бот сразу создаёт ветку матча и ждёт результат.')}
${rule('Бан и пик — разные вещи', '<b>Бан убирает вариант у обоих.</b> <b>Пик — нет.</b> Одного и того же героя или агента могут взять обе команды, и это не поломка: смысл драфта в том, что чужой пик видно, и под него берут контрпик. Пул, который забирал бы героя у соперника, эту возможность как раз и убивал бы — контрить было бы нечем.')}
${rule('Агенты Valorant', 'Делить агентов — <b>правило сервера, а не Riot</b>: в самой игре запрета нет и клиент ничему не мешает. Держится на честности, как и драфт героев Dota, — зато после матча спорить «мы такого не банили» не о чем, потому что запись открыта обоим.')}
${rule('Драфт и клиент', 'Ни один драфт бот в игре не включает: он не может. Договорённость воспроизводят руками — Dota на All Pick, Valorant выбором агентов в лобби. Смысл страницы в том, что она остаётся протоколом.')}
${rule('Брошенный турнир', 'Шесть часов без единого изменения — турнир закрывается как брошенный, комнаты убираются. Победителя не присуждаем: победа тому, кто не играл, осталась бы в зале славы навсегда.')}
${rule('Ранг Valorant', 'Подтвердить владение аккаунтом Valorant нечем — ни API, ни входа. Ранг там заявляет сам игрок, и в лидерборде он помечен «заявлено». Роль за ранг такая привязка не даёт.')}
</dl>

<h2>С чего начать прямо сейчас</h2>
<p class="lede">Если ты только зашёл — три команды в Discord, по порядку.</p>
<dl style="margin:0">
${rule('/start', 'Бот посмотрит именно твоё состояние и назовёт один следующий шаг. Не список возможностей, а то, чего не хватает тебе.')}
${rule('/link', 'Привязать игровой аккаунт. Дальше ранг и роль обновляются сами.')}
${rule('/lfg roles', 'Подписаться на игры, чтобы бот упоминал тебя, когда собирают компанию.')}
</dl>`;
}
