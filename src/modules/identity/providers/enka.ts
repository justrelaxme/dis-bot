import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';
import { normalizeAbyssRank } from '../ranks/genshin.js';
import type {
  GameProfile,
  GameProvider,
  RankInfo,
  VerificationChallenge,
  VerifiedAccount,
} from './provider.js';

/**
 * Genshin Impact через Enka.Network.
 *
 * У HoYoverse публичного API нет вообще — ни профилей, ни рангов, ни списка персонажей.
 * Enka читает то, что игра сама выкладывает в витрину профиля, и раздаёт это открыто по UID.
 * Другого способа узнать про аккаунт Genshin, не спрашивая у игрока пароль или cookie от
 * HoYoLAB, не существует, а спрашивать их бот не будет: это чужие ключи от чужого аккаунта,
 * и место им не в базе Discord-бота.
 *
 * Цена этого решения одна и её надо знать: **состав аккаунта проверить нельзя**. Enka видит
 * только витрину — до восьми персонажей, которых игрок туда поставил сам. Ни «есть ли у него
 * Фурина», ни «сколько у него пятизвёздочных» из этого не следует, и любой список доступных
 * персонажей на турнире остаётся заявленным, а не подтверждённым. Ровно как заявленный ранг
 * Valorant.
 *
 * Подтвердить владение аккаунтом при этом можно, и по-настоящему: подпись профиля меняется
 * только из игры. Игрок ставит в неё выданный код, бот его читает — значит, аккаунт его.
 */

const ENKA_BASE = 'https://enka.network/api/uid';
/**
 * Enka просит представляться и не долбить её API. Оба требования выполняются здесь: имя в
 * User-Agent и общая квота ниже. Ответы к тому же кэшируются обёрткой withCache, как у
 * остальных провайдеров.
 */
const ENKA_UA = 'dis-bot/1.0 (Discord tournament bot; +https://enka.network)';
/** Пять запросов в минуту: Enka открытая и бесплатная, и вести себя с ней надо соответственно. */
const ENKA_LIMITS: Limit[] = [{ tokens: 5, windowMs: 60_000 }];

const VERIFICATION_TTL_MS = 15 * 60 * 1_000;
/** Без похожих друг на друга символов: код придётся перепечатывать вручную в клиенте игры. */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const CODE_LENGTH = 6;

/**
 * UID — девять или десять цифр. Проверяется здесь, а не запросом: опечатка в UID иначе
 * потратила бы обращение к чужому бесплатному API и вернулась бы как «игрок не найден»,
 * что неправда — такого игрока и не бывает.
 */
const UID_RE = /^\d{9,10}$/;

const playerInfoSchema = z.object({
  nickname: z.string().optional(),
  level: z.number().optional(),
  worldLevel: z.number().optional(),
  signature: z.string().optional(),
  towerFloorIndex: z.number().nullish(),
  towerLevelIndex: z.number().nullish(),
});

const enkaResponseSchema = z.object({
  uid: z.union([z.string(), z.number()]).optional(),
  playerInfo: playerInfoSchema,
});

type EnkaResponse = z.infer<typeof enkaResponseSchema>;

export interface EnkaProviderDeps {
  client: FetchClient;
  rateLimiter: RateLimiter;
}

function requireUid(uid: string): string {
  const trimmed = uid.trim();
  if (!UID_RE.test(trimmed)) {
    throw new UserError('UID Genshin — это девять или десять цифр, они видны в правом нижнем углу игры.');
  }
  return trimmed;
}

/** Ник в витрине пустует у совсем новых аккаунтов. Показывать вместо него UID честнее прочерка. */
function displayNameOf(info: EnkaResponse['playerInfo'], uid: string): string {
  const nickname = info.nickname?.trim();
  return nickname && nickname.length > 0 ? nickname : `UID ${uid}`;
}

export function createEnkaProvider(deps: EnkaProviderDeps): GameProvider {
  async function fetchPlayer(uid: string): Promise<EnkaResponse> {
    await deps.rateLimiter.acquire('enka', ENKA_LIMITS);
    return deps.client.json<EnkaResponse>(`${ENKA_BASE}/${uid}/?info`, {
      headers: { 'User-Agent': ENKA_UA },
      schema: enkaResponseSchema,
    });
  }

  return {
    id: 'enka',
    capabilities: { verification: 'genshin-signature', rank: 'api' },

    async startVerification(): Promise<VerificationChallenge> {
      const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      return {
        challenge: code,
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        payload: {},
        instruction:
          `Открой Genshin Impact → Паймон → Профиль → Изменить подпись и впиши туда этот код:\n\`${code}\`\n\n` +
          'Подпись можно менять только из игры, поэтому она и подтверждает, что аккаунт твой. ' +
          'Потом вернись сюда и повтори команду с тем же UID. Код действует 15 минут, после ' +
          'подтверждения подпись можно вернуть какой была.',
      };
    },

    async completeVerification(challenge, uid): Promise<VerifiedAccount> {
      const id = requireUid(uid);
      const player = await fetchPlayer(id);
      const signature = player.playerInfo.signature ?? '';

      // Код ищется внутри подписи, а не сверяется с ней целиком: стирать свою подпись ради
      // проверки никого заставлять не нужно, дописать код в конец достаточно.
      if (!signature.toUpperCase().includes(challenge.challenge.toUpperCase())) {
        throw new UserError(
          'Не нашёл код в подписи профиля. Проверь, что вписал его в игре и нажал подтвердить — ' +
            'Enka видит подпись не мгновенно, так что через минуту попробуй ещё раз.',
        );
      }

      return {
        externalId: id,
        displayName: displayNameOf(player.playerInfo, id),
        verificationMethod: 'genshin-signature',
      };
    },

    async fetchProfile(uid: string): Promise<GameProfile> {
      const id = requireUid(uid);
      const player = await fetchPlayer(id);
      return { externalId: id, displayName: displayNameOf(player.playerInfo, id) };
    },

    /**
     * Ранга у Genshin нет, поэтому здесь Витая Бездна. Пустой массив означает «Бездна не
     * пройдена» — так же, как unranked у остальных: аккаунт привязан, ранга пока нет.
     */
    async fetchRank(uid: string): Promise<RankInfo[]> {
      const id = requireUid(uid);
      const player = await fetchPlayer(id);
      const rank = normalizeAbyssRank(player.playerInfo);
      return rank ? [rank] : [];
    },
  };
}
