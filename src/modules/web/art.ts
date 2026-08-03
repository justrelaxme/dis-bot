import { VALORANT_MAPS } from '../tournaments/draft/pools.js';
import type { TournamentGame } from '../tournaments/schema.js';

/**
 * Игровой арт: единственное место, где на витрине появляются ссылки на внешние картинки.
 *
 * Картинки берутся с CDN самих игр по ссылке, а не складываются в репозиторий. Причин три,
 * и все практические. Во-первых, вес: сто двадцать семь портретов героев — это восемь
 * мегабайт в git навсегда, и каждый патч добавлял бы ещё. Во-вторых, актуальность: новый
 * герой появляется на CDN Valve в день выхода патча, а в скачанном архиве — когда кто-то
 * вспомнит его обновить. В-третьих, права: раздавать чужие изображения со своего сервера
 * означает распространять их, а ссылаться — не означает.
 *
 * Цена решения одна: без интернета у зрителя картинок не будет. Поэтому ни одна страница
 * от них не зависит — везде, где есть картинка, рядом есть подпись, и разметка рассчитана
 * на то, что картинка не пришла.
 *
 * Проверено по всему списку: путь `dota_react` есть у всех 127 героев, а старые
 * вертикальные портреты — нет (у Marci, Muerta, Dawnbreaker и Primal Beast их не публикуют).
 */

const DOTA_CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';
const VALORANT_CDN = 'https://media.valorant-api.com/agents';
const RIOT_CDN = 'https://ddragon.leagueoflegends.com/cdn/img/champion/loading';

/** Портрет героя Dota, 256×144. Тот же путь, что и в пуле драфта. */
export function dotaHeroArt(slug: string): string {
  return `${DOTA_CDN}/${slug}.png`;
}

/** Лицо агента Valorant, 10 КБ. Крупные портреты — по 600 КБ, для полосы это неприемлемо. */
function valorantAgentArt(uuid: string): string {
  return `${VALORANT_CDN}/${uuid}/killfeedportrait.png`;
}

/** Портрет чемпиона League of Legends, 44 КБ. Той же картинкой игра встречает в загрузке. */
function riotChampionArt(name: string): string {
  return `${RIOT_CDN}/${name}_0.jpg`;
}

export interface GameIdentity {
  /**
   * Акцентный цвет дисциплины. Подставляется в `--accent` на корне страницы, и от него
   * зависит всё, что на странице выделено: рамки, риски, полосы, ссылки. Одна переменная
   * вместо четырёх наборов правил — иначе четыре дисциплины означали бы четыре стиля,
   * которые расходятся при первой же правке.
   */
  accent: string;
  /** Полоса арта в шапке: от трёх до восьми картинок, лишние скрывает вёрстка. */
  band: readonly string[];
  /** Откуда картинки. Подпись обязательна: это чужие изображения, и молчать о том, чьи они, неправильно. */
  credit: string;
}

/**
 * Полоса арта Valorant собрана из тех же карт, что и пул вето: показывать в шапке карту,
 * которой в турнире нет, значило бы обещать её. Агенты добавлены к ним лицами — в самой игре
 * агентов не банят и не делят (обе команды могут взять одного), поэтому здесь они только
 * узнаваемое лицо дисциплины, а не участник драфта.
 */
const VALORANT_AGENTS: readonly string[] = [
  valorantAgentArt('add6443a-41bd-e414-f6ad-e58d267f4e95'), // Jett
  valorantAgentArt('a3bfb853-43b2-7238-a4f1-ad90e9e46bcc'), // Reyna
  valorantAgentArt('8e253930-4c05-31dd-1b6c-968525494517'), // Omen
  valorantAgentArt('320b2a48-4d9b-a075-30f1-1f93a9b638fa'), // Sova
  valorantAgentArt('1e58de9c-4950-5125-93e9-a0aee9f98746'), // Killjoy
];

export const VALORANT_AGENT_FACES = VALORANT_AGENTS;

export const GAME_IDENTITY: Record<TournamentGame, GameIdentity> = {
  // Огненно-оранжевый. Dota подписывает себя тёмно-красным, но рядом с малиновым Valorant
  // красный от красного не отличить — а вся затея с цветом дисциплины в том, чтобы
  // страницы различались на глаз. Поэтому взят тёплый край её же палитры.
  dota2: {
    accent: '#e07a2f',
    band: [
      dotaHeroArt('pudge'),
      dotaHeroArt('invoker'),
      dotaHeroArt('juggernaut'),
      dotaHeroArt('crystal_maiden'),
      dotaHeroArt('phantom_assassin'),
      dotaHeroArt('axe'),
    ],
    credit: 'Портреты героев — Valve, CDN Dota 2',
  },
  // Официальный красный Valorant. Единственный акцент, взятый у игры буквально: он и есть
  // её опознавательный знак.
  valorant: {
    accent: '#ff4655',
    // Лицо, карта, лицо, карта: фотографии карт в узкой панели читаются хуже портретов, и
    // вперемешку полоса выходит ритмичнее, чем четыре серых пейзажа подряд. На узком экране
    // остаются первые панели — то есть лицо там будет всегда.
    band: [0, 1, 2]
      .flatMap((index) => [VALORANT_AGENTS[index] ?? '', VALORANT_MAPS[index]?.imageUrl ?? ''])
      .filter(Boolean),
    credit: 'Карты и агенты — Riot Games, valorant-api.com',
  },
  lol: {
    accent: '#c8aa6e',
    band: ['Ahri', 'Jinx', 'Yasuo', 'LeeSin', 'Lux', 'Ekko'].map(riotChampionArt),
    credit: 'Портреты чемпионов — Riot Games, Data Dragon',
  },
  // Фиолетовый Конвергенции: TFT играется теми же чемпионами, и отличать её от League
  // приходится цветом, а не картинками.
  tft: {
    accent: '#8f7bd8',
    band: ['Veigar', 'Teemo', 'Katarina', 'Garen', 'Lux', 'Jinx'].map(riotChampionArt),
    credit: 'Портреты чемпионов — Riot Games, Data Dragon',
  },
};

/**
 * Полоса для страниц, которые не про одну дисциплину: список турниров, зал славы, правила.
 * Смешана нарочно — эти страницы про сервер, а не про игру, и одна дисциплина в шапке
 * назначила бы главной ту, которая просто оказалась первой в списке.
 */
export const SERVER_BAND: readonly string[] = [
  dotaHeroArt('pudge'),
  VALORANT_MAPS[0]?.imageUrl ?? '',
  riotChampionArt('Ahri'),
  dotaHeroArt('invoker'),
  VALORANT_MAPS[2]?.imageUrl ?? '',
  riotChampionArt('Jinx'),
].filter(Boolean);

export const SERVER_CREDIT = 'Изображения — Valve и Riot Games, с их публичных CDN';
