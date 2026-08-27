import { createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';

/**
 * Полный состав аккаунта Genshin — из Летописи HoYoLAB.
 *
 * Это единственный источник, который отдаёт всех персонажей игрока, а не витрину из восьми.
 * Enka показывает то, что игрок выставил сам; Летопись — то, что у него есть. Для турнира с
 * банами разница принципиальная: банить персонажа, которого у соперника и не было, — не бан.
 *
 * Устроено оно не так, как у Riot или Valve, и знать это надо заранее:
 *
 * - **Ключ здесь не выдаётся, а берётся из браузера.** Публичного API у HoYoverse нет, есть
 *   внутренний, которым разговаривает сайт HoYoLAB. Поэтому вместо ключа — cookie от
 *   аккаунта HoYoLAB владельца бота. Один раз, свои, а не игроков: чужие ключи бот не
 *   спрашивает и спрашивать не будет.
 * - **Спрашивающий и тот, про кого спрашивают, — разные люди.** Cookie нужны только для
 *   того, чтобы запрос вообще приняли. Данные при этом отдаются про любой UID, чья Летопись
 *   переключена в публичную. Игроку остаётся один тумблер в настройках HoYoLAB.
 * - **Запрос подписывается.** Заголовок `DS` — это `t,r,md5(salt=…&t=…&r=…)`. Соль нигде не
 *   опубликована и меняется без предупреждения. Когда это случится, провайдер начнёт
 *   отвечать отказом, состав станет заявленным, и турниры продолжатся — но правится это
 *   одной константой ниже, и другого места у неё нет.
 *
 * Ни один путь наружу от этого не зависит: нет cookie, закрыта Летопись, сменилась соль —
 * всюду `null`, и состав остаётся тем, что заявил игрок.
 */

const CHRONICLE_BASE = 'https://bbs-api-os.hoyolab.com/game_record/genshin/api';

/**
 * Состав читается двумя запросами, и это не прихоть.
 *
 * `character/list` отдаёт **всех** персонажей аккаунта — с уровнем и созвездием, но без
 * снаряжения. `character/detail` по их идентификаторам добирает надетое оружие с огранкой и
 * артефакты. Раньше существовал один эндпоинт `character`, который отдавал всё сразу; бот звал
 * именно его, и это была ошибка — HoYoLAB давно разделил вызовы, и старый путь держится на
 * честном слове.
 *
 * Важное, о чём легко ошибиться: ни один из этих двух не имеет отношения к витрине профиля.
 * Витрина — это восемь слотов, которые игрок выставляет сам (её задаёт отдельный
 * `character/top`), и читает её Enka. Летопись знает весь аккаунт целиком.
 */
const LIST_PATH = 'character/list';
const DETAIL_PATH = 'character/detail';

/**
 * Соль для подписи зарубежного HoYoLAB и версия клиента, которой представляется запрос.
 * Обе величины — из сетевого обмена сайта HoYoLAB, а не из документации: документации нет.
 * Если состав перестал приходить с жалобой на подпись, менять надо здесь.
 */
const DS_SALT = '6s25p5ox5y14umn1p61aqyyvbvvl3lrt';
const APP_VERSION = '1.5.0';
/** 5 — веб-клиент. Тот же тип, что ставит сайт HoYoLAB в браузере. */
const CLIENT_TYPE = '5';

/** Десять запросов в минуту. Чужой внутренний API: вести себя надо тише, чем позволено. */
const CHRONICLE_LIMITS: Limit[] = [{ tokens: 10, windowMs: 60_000 }];

const DS_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Регион считается по первой цифре UID, потому что запрос его требует, а игрок его не знает:
 * в самой игре слово «os_euro» не встречается нигде. Десятизначные UID зарубежной Азии
 * начинаются на «18» — поэтому сначала проверяются две цифры, потом одна.
 *
 * Китайские UID (1, 2, 3, 5) живут на другом хосте, с другой солью и другим приложением.
 * Поддерживать их — отдельная работа, и делать вид, что они работают, хуже, чем сказать прямо.
 */
export function serverForUid(uid: string): string | null {
  if (uid.startsWith('18')) return 'os_asia';
  switch (uid[0]) {
    case '6':
      return 'os_usa';
    case '7':
      return 'os_euro';
    case '8':
      return 'os_asia';
    case '9':
      return 'os_cht';
    default:
      return null;
  }
}

/** Подпись запроса. Время в секундах, шесть случайных букв, md5 от них с солью. */
function signature(now: number): string {
  const time = Math.floor(now / 1_000);
  const random = Array.from({ length: 6 }, () => DS_ALPHABET[randomInt(DS_ALPHABET.length)]).join('');
  const hash = createHash('md5').update(`salt=${DS_SALT}&t=${time}&r=${random}`).digest('hex');
  return `${time},${random},${hash}`;
}

/** Оружие персонажа. `affix_level` — это огранка, от 1 до 5; своего слова для неё в ответе нет. */
const weaponSchema = z.object({
  name: z.string(),
  rarity: z.number().optional(),
  level: z.number().optional(),
  affix_level: z.number().optional(),
});

/** Надетый артефакт. Из него нужен только комплект: позиция и уровень на стоимость не влияют. */
const reliquarySchema = z.object({
  set: z.object({ name: z.string() }).optional(),
});

const avatarSchema = z.object({
  id: z.number(),
  name: z.string(),
  element: z.string().optional(),
  /** Редкость: 5 у пятизвёздочных, 4 у четырёхзвёздочных. У пробных бывает 105 — см. ниже. */
  rarity: z.number().optional(),
  level: z.number().optional(),
  /** Созвездие: от 0 до 6. Разница между C0 и C6 в Genshin больше, чем между уровнями. */
  actived_constellation_num: z.number().optional(),
  icon: z.string().optional(),
  /**
   * Оружие и артефакты приходят не всегда: у неподнятого персонажа их может не быть вовсе, а
   * ответ HoYoLAB не обещает ни одного из этих полей. Поэтому оба необязательны, и отсутствие
   * означает «неизвестно», а не «нет».
   */
  weapon: weaponSchema.optional(),
  /** Старый эндпоинт звал их `reliquaries`, новый `character/detail` — `relics`. Ждём оба. */
  reliquaries: z.array(reliquarySchema).optional(),
  relics: z.array(reliquarySchema).optional(),
});

/**
 * Ответ приходит под разными именами в разных версиях API: старый `character` клал персонажей
 * в `avatars`, `character/list` и `character/detail` — в `list`. Принимаем оба: разница
 * косметическая, а падать из-за неё значило бы остаться без состава на ровном месте.
 */
const rosterSchema = z.object({
  retcode: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      avatars: z.array(avatarSchema).optional(),
      list: z.array(avatarSchema).optional(),
    })
    .nullable()
    .optional(),
});

export interface OwnedWeapon {
  name: string;
  rarity: number;
  /** Огранка, от 1 до 5. В ответе HoYoLAB это `affix_level`. */
  refinement: number;
  level: number;
}

export interface OwnedCharacter {
  /** Тот же идентификатор, что и в справочнике Enka: по нему состав сходится с пулом драфта. */
  id: string;
  name: string;
  level: number;
  constellation: number;
  rarity: number;
  /**
   * Адрес иконки, как его отдаёт Летопись. Берётся её собственный, а не собирается из имени
   * файла: имя иконки в ответе HoYoLAB не приходит вовсе, а выводить его из идентификатора
   * нельзя — они не связаны.
   */
  iconUrl?: string;
  /** Что надето. Отсутствие означает «неизвестно»: у неподнятого персонажа оружия может не быть. */
  weapon?: OwnedWeapon;
  /**
   * Комплекты артефактов: имя и сколько предметов надето. Очков не стоят — артефакты фармятся
   * временем, а не деньгами, — но говорят, насколько персонаж собран, а это и есть то, что
   * хотят знать перед матчем.
   */
  sets: { name: string; pieces: number }[];
}

export interface HoyolabDeps {
  client: FetchClient;
  rateLimiter: RateLimiter;
  /**
   * Строка Cookie целиком, как её отдаёт браузер: важны `ltoken_v2` и `ltuid_v2`. Отсутствие
   * — законное состояние: без неё состав просто остаётся заявленным.
   */
  cookie?: string;
  /** Подменяется в тестах, чтобы подпись была предсказуемой. */
  now?: () => number;
}

/**
 * Причина, по которой состав не пришёл. Нужна, чтобы сказать игроку, что делать: «включи
 * публичную Летопись» и «у бота нет ключа» — это разные проблемы разных людей, и общая
 * фраза «не получилось» не помогает ни тому, ни другому.
 */
export type RosterFailure = 'no-cookie' | 'unsupported-region' | 'private' | 'unavailable';

export type RosterResult =
  | { ok: true; characters: OwnedCharacter[] }
  | { ok: false; reason: RosterFailure };

/** Летопись закрыта или UID не тот. Коды из ответов HoYoLAB, документации к ним нет. */
const PRIVATE_CODES = new Set([10102, 10104, 1034]);

/**
 * Комплекты артефактов: сколько предметов какого набора надето. Считается по именам, потому
 * что «четыре из Багровой ведьмы» — это то, как о сборке говорят, а какие именно предметы в
 * этих четырёх, значения не имеет.
 */
function setsOf(
  reliquaries: { set?: { name: string } | undefined }[] | undefined,
): { name: string; pieces: number }[] {
  if (!reliquaries) return [];

  const counts = new Map<string, number>();
  for (const item of reliquaries) {
    const name = item.set?.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // Больший комплект вперёд: у сборки «4+0» и «2+2» на первом месте должно стоять то, что
  // определяет её целиком.
  return [...counts]
    .map(([name, pieces]) => ({ name, pieces }))
    .sort((a, b) => b.pieces - a.pieces || a.name.localeCompare(b.name, 'ru'));
}

export function createHoyolabChronicle(deps: HoyolabDeps) {
  const now = deps.now ?? ((): number => Date.now());

  return {
    /** Есть ли у бота ключ вообще. По этому решается, обещать ли игроку проверку состава. */
    configured: Boolean(deps.cookie),

    /**
     * Состав аккаунта. Никогда не бросает из-за чужого API: любой отказ возвращается
     * причиной, потому что турнир не должен зависеть от настроения HoYoLAB.
     */
    async roster(uid: string): Promise<RosterResult> {
      const cookie = deps.cookie;
      if (!cookie) return { ok: false, reason: 'no-cookie' };

      const server = serverForUid(uid);
      if (!server) return { ok: false, reason: 'unsupported-region' };

      /** Один запрос к Летописи: заголовки, подпись и квота у них общие. */
      const ask = async (path: string, payload: Record<string, unknown>): Promise<z.infer<typeof rosterSchema>> => {
        await deps.rateLimiter.acquire('hoyolab', CHRONICLE_LIMITS);
        return deps.client.json<z.infer<typeof rosterSchema>>(`${CHRONICLE_BASE}/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            DS: signature(now()),
            'x-rpc-app_version': APP_VERSION,
            'x-rpc-client_type': CLIENT_TYPE,
            'x-rpc-language': 'ru-ru',
          },
          body: JSON.stringify({ role_id: uid, server, ...payload }),
          schema: rosterSchema,
        });
      };

      let body: z.infer<typeof rosterSchema>;
      try {
        body = await ask(LIST_PATH, {});
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      if (body.retcode !== 0 || !body.data) {
        return { ok: false, reason: PRIVATE_CODES.has(body.retcode) ? 'private' : 'unavailable' };
      }

      const listed = body.data.avatars ?? body.data.list ?? [];

      /**
       * Снаряжение добирается вторым запросом. Отказ здесь состав не отменяет: без оружия
       * цена посчитается по одним созвездиям — заниженная, но состав будет виден, и это
       * лучше, чем пустая страница из-за одного неудачного вызова.
       */
      let detailed = listed;
      if (listed.length > 0) {
        try {
          const detail = await ask(DETAIL_PATH, { character_ids: listed.map((avatar) => avatar.id) });
          const full = detail.retcode === 0 ? (detail.data?.list ?? detail.data?.avatars ?? []) : [];
          if (full.length > 0) {
            const byId = new Map(full.map((avatar) => [avatar.id, avatar]));
            detailed = listed.map((avatar) => ({ ...avatar, ...(byId.get(avatar.id) ?? {}) }));
          }
        } catch {
          // Намеренно тихо: список персонажей уже есть, а снаряжение — уточнение к нему.
        }
      }

      const characters = detailed
        .map((avatar) => ({
          id: String(avatar.id),
          name: avatar.name,
          level: avatar.level ?? 1,
          constellation: avatar.actived_constellation_num ?? 0,
          // Пробным персонажам HoYoLAB ставит редкость 105 вместо 5. Приводится к пятёрке:
          // иначе «пятизвёздочных: 0» у аккаунта, где они есть, и сортировка врёт.
          rarity: avatar.rarity === undefined ? 4 : avatar.rarity > 100 ? avatar.rarity - 100 : avatar.rarity,
          ...(avatar.icon ? { iconUrl: avatar.icon } : {}),
          ...(avatar.weapon
            ? {
                weapon: {
                  name: avatar.weapon.name,
                  rarity: avatar.weapon.rarity ?? 1,
                  // Огранка начинается с единицы: R1 — это оружие без единой копии.
                  refinement: avatar.weapon.affix_level ?? 1,
                  level: avatar.weapon.level ?? 1,
                },
              }
            : {}),
          sets: setsOf(avatar.reliquaries ?? avatar.relics),
        }))
        .sort((a, b) => b.rarity - a.rarity || b.level - a.level || a.name.localeCompare(b.name, 'ru'));

      return { ok: true, characters };
    },
  };
}

export type HoyolabChronicle = ReturnType<typeof createHoyolabChronicle>;

/** Что сказать игроку про неудачу. Каждая причина — своё действие, а не общее «попробуй позже». */
export function explainRosterFailure(reason: RosterFailure): string {
  switch (reason) {
    case 'no-cookie':
      return 'Проверка состава на этом сервере не настроена, поэтому персонажи считаются заявленными.';
    case 'unsupported-region':
      return 'Состав читается только у зарубежных аккаунтов (UID на 6, 7, 8 или 9). У китайских серверов отдельный API, и он не подключён.';
    case 'private':
      return 'Летопись закрыта. Открой её в HoYoLAB → Летопись → шестерёнка → «Сделать публичной», и состав подтянется сам.';
    case 'unavailable':
      return 'HoYoLAB сейчас не отвечает — состав подтянется позже сам, турнир этого не ждёт.';
  }
}

/** Одна строка про аккаунт: сколько персонажей и сколько из них пятизвёздочных. */
export function describeRoster(characters: readonly OwnedCharacter[]): string {
  const fives = characters.filter((character) => character.rarity >= 5).length;
  return `персонажей ${characters.length}, из них пятизвёздочных ${fives}`;
}

/** UID зарубежного региона? Нужно там, где до провайдера не достать. */
export function chronicleSupports(uid: string): boolean {
  return serverForUid(uid) !== null;
}

export { UserError };
