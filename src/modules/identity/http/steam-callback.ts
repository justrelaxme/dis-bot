import type { FastifyInstance } from 'fastify';
import { describeForUser, UserError } from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import type { GameProvider, VerifiedAccount } from '../providers/provider.js';
import { verifySteamAssertion } from '../providers/steam-openid.js';
import type { ProviderId } from '../schema.js';
import type { LinkingService } from '../services/linking.js';

export interface SteamCallbackDeps {
  logger: Logger;
  linking: Pick<LinkingService, 'takeChallenge' | 'linkAccount' | 'listAccounts'>;
  providers: Map<ProviderId, GameProvider>;
  /** Подменяется в тестах, чтобы не ходить в Steam. */
  verifyAssertion?: (params: URLSearchParams) => Promise<string>;
  /** Отправка сообщения пользователю в Discord. */
  notify: (userId: string, text: string) => Promise<void>;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.6"><h1>${title}</h1><p>${body}</p></body></html>`;
}

/**
 * Колбэк, на который Steam возвращает игрока после входа через OpenID.
 *
 * КРИТИЧНО: SteamID берётся только из результата verify(query) (по умолчанию —
 * verifySteamAssertion, которая переспрашивает сам Steam через check_authentication),
 * а не разбирается напрямую из query.get('openid.claimed_id'). Параметрам запроса
 * верить нельзя — тот же самый URL с любым claimed_id соберёт любой, кто знает адрес
 * колбэка, и без сверки с Steam это была бы привязка чужого аккаунта по одной ссылке.
 */
export function registerSteamCallback(server: FastifyInstance, deps: SteamCallbackDeps): void {
  const verify = deps.verifyAssertion ?? ((params: URLSearchParams) => verifySteamAssertion(params, {}));

  server.get('/steam/callback', async (request, reply) => {
    const query = new URLSearchParams(request.url.split('?')[1] ?? '');
    const state = query.get('state');

    if (!state) {
      return reply
        .code(400)
        .type('text/html')
        .send(page('Чего-то не хватает', 'В ссылке нет метки запроса. Запусти /link steam заново.'));
    }

    let steamId: string;
    try {
      steamId = await verify(query);
    } catch (error) {
      deps.logger.warn({ err: error }, 'Steam не подтвердил возврат');
      return reply
        .code(400)
        .type('text/html')
        .send(page('Не удалось подтвердить вход', 'Steam не подтвердил подпись. Запусти /link steam заново.'));
    }

    let owner: { userId: string; provider: ProviderId };
    try {
      owner = await deps.linking.takeChallenge(state);
      if (owner.provider !== 'steam') {
        // Испытание существует и не истекло, но выдано другому провайдеру: challenge
        // уникален глобально (account_verifications_challenge_uq не разделяет провайдеров),
        // поэтому чужой код верификации (например, третьесторонний код Riot) синтаксически
        // пройдёт takeChallenge и здесь. Погасить его на Steam-роуте — значит привязать
        // свой Steam-аккаунт к чужому Discord-профилю по чужому секрету.
        throw new Error(`испытание принадлежит провайдеру ${owner.provider}, а не steam`);
      }
    } catch (error) {
      deps.logger.warn({ err: error }, 'неизвестная или просроченная метка запроса Steam');
      return reply
        .code(400)
        .type('text/html')
        .send(page('Ссылка устарела', 'Метка запроса не найдена или истекла. Запусти /link steam заново.'));
    }

    const provider = deps.providers.get('steam');
    if (!provider?.completeVerification) {
      return reply.code(500).type('text/html').send(page('Бот настроен неверно', 'Провайдер Steam не подключён.'));
    }

    // Отказ до и включая linkAccount — это неудача привязки: нет STEAM_API_KEY (UserError
    // из fetchProfile), аккаунт уже привязан к другому Discord-профилю (UserError из
    // linkAccount) или Steam недоступен/открыт circuit breaker (ProviderError) — всё это
    // реальные, достижимые исходы, а не гипотетические. Без этого try/catch Fastify
    // отдаёт игроку сырой JSON-500 с текстом внутренней ошибки вместо страницы на русском.
    let verified: VerifiedAccount;
    try {
      verified = await provider.completeVerification(
        { challenge: state, expiresAt: new Date(Date.now() + 60_000), payload: {} },
        steamId,
      );
      await deps.linking.linkAccount(owner.userId, 'steam', verified, true);
    } catch (error) {
      const described = describeForUser(error);
      if (described.incidentId) {
        deps.logger.error({ err: error, incidentId: described.incidentId }, 'привязка Steam упала на завершающем шаге');
      } else {
        deps.logger.warn({ err: error }, 'привязка Steam не завершилась: ожидаемый отказ');
      }
      // UserError — ожидаемый, предназначенный игроку текст (например, «аккаунт уже
      // привязан» или «нет STEAM_API_KEY» — админская подсказка, а не наша внутренняя
      // деталь). Всё остальное — обобщённая формулировка без деталей исключения.
      const status = error instanceof UserError ? 400 : 500;
      return reply.code(status).type('text/html').send(page('Не удалось завершить привязку', described.text));
    }

    // Аккаунт уже записан в базе — дальше только уведомление в Discord, и его сбой не
    // должен превращать состоявшуюся привязку в страницу с ошибкой. Закрытые личные
    // сообщения от участников сервера — штатная настройка приватности части игроков, а
    // не признак неудачи. Результат игрок и так видит на этой странице колбэка, сообщение
    // в Discord — приятное дополнение, а не носитель результата, поэтому его отказ только
    // логируется и не влияет на ответ.
    try {
      await deps.notify(
        owner.userId,
        `Steam привязан: **${verified.displayName}**. Ранг Dota подтянется автоматически.`,
      );
    } catch (error) {
      deps.logger.warn({ err: error }, 'не удалось отправить уведомление о привязке Steam в Discord');
    }

    return reply
      .code(200)
      .type('text/html')
      .send(
        page('Готово', `Аккаунт <b>${verified.displayName}</b> привязан. Можно закрыть страницу и вернуться в Discord.`),
      );
  });
}
