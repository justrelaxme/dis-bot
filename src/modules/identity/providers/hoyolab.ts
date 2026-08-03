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
});

const rosterSchema = z.object({
  retcode: z.number(),
  message: z.string().optional(),
  data: z.object({ avatars: z.array(avatarSchema) }).nullable().optional(),
});

export interface OwnedCharacter {
  /** Тот же идентификатор, что и в справочнике Enka: по нему состав сходится с пулом драфта. */
  id: string;
  name: string;
  level: number;
  constellation: number;
  rarity: number;
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

      await deps.rateLimiter.acquire('hoyolab', CHRONICLE_LIMITS);

      let body: z.infer<typeof rosterSchema>;
      try {
        body = await deps.client.json<z.infer<typeof rosterSchema>>(`${CHRONICLE_BASE}/character`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            DS: signature(now()),
            'x-rpc-app_version': APP_VERSION,
            'x-rpc-client_type': CLIENT_TYPE,
            'x-rpc-language': 'ru-ru',
          },
          body: JSON.stringify({ role_id: uid, server }),
          schema: rosterSchema,
        });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      if (body.retcode !== 0 || !body.data) {
        return { ok: false, reason: PRIVATE_CODES.has(body.retcode) ? 'private' : 'unavailable' };
      }

      const characters = body.data.avatars
        .map((avatar) => ({
          id: String(avatar.id),
          name: avatar.name,
          level: avatar.level ?? 1,
          constellation: avatar.actived_constellation_num ?? 0,
          // Пробным персонажам HoYoLAB ставит редкость 105 вместо 5. Приводится к пятёрке:
          // иначе «пятизвёздочных: 0» у аккаунта, где они есть, и сортировка врёт.
          rarity: avatar.rarity === undefined ? 4 : avatar.rarity > 100 ? avatar.rarity - 100 : avatar.rarity,
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
