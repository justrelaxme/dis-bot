import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSteamCallback } from '../../../src/modules/identity/http/steam-callback.js';
import { createLogger } from '../../../src/core/logger.js';
import type { Config } from '../../../src/core/config.js';
import { ProviderError, UserError } from '../../../src/core/errors.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function serverWith(overrides: Partial<Parameters<typeof registerSteamCallback>[1]> = {}) {
  const server = Fastify({ logger: false });
  const deps = {
    logger,
    linking: {
      takeChallenge: vi.fn(async () => ({ userId: '222222222222222222', provider: 'steam' as const, payload: {} })),
      linkAccount: vi.fn(async () => 1),
      listAccounts: vi.fn(async () => []),
    },
    providers: new Map([
      [
        'steam' as const,
        {
          id: 'steam' as const,
          capabilities: { verification: 'steam-openid' as const, rank: 'api' as const },
          completeVerification: vi.fn(async () => ({
            externalId: '76561198000000001',
            displayName: 'alice',
            verificationMethod: 'steam-openid' as const,
          })),
          fetchProfile: vi.fn(),
        },
      ],
    ]),
    verifyAssertion: vi.fn(async () => '76561198000000001'),
    notify: vi.fn(async () => {}),
    ...overrides,
  };
  registerSteamCallback(server, deps as never);
  return { server, deps };
}

describe('роут /steam/callback', () => {
  it('привязывает аккаунт и отвечает страницей об успехе', async () => {
    const { server, deps } = serverWith();

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Discord');
    expect(deps.linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'steam', expect.any(Object), true);
    await server.close();
  });

  it('отвечает 400 без параметра state', async () => {
    const { server } = serverWith();
    const response = await server.inject({ method: 'GET', url: '/steam/callback?openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('не привязывает, когда Steam не подтвердил подпись', async () => {
    const { server, deps } = serverWith({
      verifyAssertion: vi.fn(async () => {
        throw new Error('подпись не подтверждена');
      }),
    } as never);

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    expect(deps.linking.linkAccount).not.toHaveBeenCalled();
    await server.close();
  });

  it('отвечает 400 по неизвестному или просроченному state', async () => {
    const { server } = serverWith({
      linking: {
        takeChallenge: vi.fn(async () => {
          throw new Error('код не найден');
        }),
        linkAccount: vi.fn(),
        listAccounts: vi.fn(),
      },
    } as never);

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=ЧУЖОЙ&openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('уведомляет пользователя в Discord об успехе', async () => {
    const { server, deps } = serverWith();
    await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(deps.notify).toHaveBeenCalledWith('222222222222222222', expect.stringContaining('alice'));
    await server.close();
  });

  it('отвечает страницей успеха, даже если не удалось отправить уведомление в Discord', async () => {
    // Аккаунт к этому моменту уже записан в базе (linkAccount отработал) — notify лишь
    // приятное дополнение, а не носитель результата. Закрытые личные сообщения от
    // участников сервера — штатная настройка приватности части игроков, а не признак
    // неудачи привязки, поэтому её сбой не должен превращать состоявшуюся привязку в
    // страницу с ошибкой (регрессия на «Хвост 2» финального ревью).
    const { server, deps } = serverWith({
      notify: vi.fn(async () => {
        throw new Error('Discord API недоступен: нельзя отправить ЛС пользователю');
      }),
    } as never);

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Discord');
    expect(response.body).not.toContain('Discord API недоступен: нельзя отправить ЛС пользователю');
    expect(deps.linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'steam', expect.any(Object), true);
    await server.close();
  });

  it('отвечает 400, если испытание погашено, но принадлежит другому провайдеру', async () => {
    // Challenge уникален глобально (account_verifications_challenge_uq не разделяет
    // провайдеров): чужой код верификации Riot синтаксически пройдёт takeChallenge и
    // здесь. Steam-роут обязан отказать, а не привязать свой Steam-аккаунт к чужому
    // Discord-профилю.
    const { server, deps } = serverWith({
      linking: {
        takeChallenge: vi.fn(async () => ({
          userId: '222222222222222222',
          provider: 'riot-lol' as const,
          payload: {},
        })),
        linkAccount: vi.fn(async () => 1),
        listAccounts: vi.fn(async () => []),
      },
    } as never);

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=ЧУЖОЙ-RIOT-КОД&openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    expect(deps.linking.linkAccount).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    await server.close();
  });

  describe('сбой на последних шагах колбэка (после takeChallenge)', () => {
    // Регрессия на Critical-находку: до фикса provider.completeVerification и
    // linking.linkAccount не были обёрнуты ничем, и Fastify без setErrorHandler отдавал
    // игроку сырой JSON {"statusCode":500,...,"message":"<текст исключения>"}. Общий для
    // всех трёх тестов инвариант — ответ обязан быть html-страницей на русском, а не
    // JSON-500 с текстом внутренней ошибки. notify сюда не входит: его сбой — отдельный
    // случай (см. «отвечает страницей успеха, даже если не удалось отправить уведомление»
    // выше) — привязка к этому моменту уже состоялась, поэтому это не неудача привязки.
    function expectSafePage(response: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).not.toContain('statusCode');
      expect(response.body).not.toContain('Internal Server Error');
    }

    it('триггер 1: нет STEAM_API_KEY — completeVerification бросает UserError', async () => {
      const { server, deps } = serverWith({
        providers: new Map([
          [
            'steam' as const,
            {
              id: 'steam' as const,
              capabilities: { verification: 'steam-openid' as const, rank: 'api' as const },
              completeVerification: vi.fn(async () => {
                throw new UserError('Интеграция со Steam не настроена: в окружении нет STEAM_API_KEY.');
              }),
              fetchProfile: vi.fn(),
            },
          ],
        ]),
      } as never);

      const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

      expectSafePage(response);
      // UserError показывается игроку как есть (см. describeForUser) — это тот же самый
      // текст, что видит администратор сервера через /link steam или /profile, поэтому
      // здесь он ожидаемо присутствует. Критично не это, а то, что тело — HTML-страница,
      // а не сырой JSON от Fastify (проверено выше через expectSafePage).
      expect(response.body).toContain('Steam');
      expect(deps.linking.linkAccount).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
      await server.close();
    });

    it('триггер 2: аккаунт уже привязан к другому пользователю — linkAccount бросает UserError', async () => {
      const { server, deps } = serverWith({
        linking: {
          takeChallenge: vi.fn(async () => ({
            userId: '222222222222222222',
            provider: 'steam' as const,
            payload: {},
          })),
          linkAccount: vi.fn(async () => {
            throw new UserError(
              'Этот игровой аккаунт уже привязан к другому пользователю сервера. Если это твой аккаунт — обратись к администратору.',
            );
          }),
          listAccounts: vi.fn(async () => []),
        },
      } as never);

      const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

      expectSafePage(response);
      expect(response.body).toContain('уже привязан');
      expect(deps.notify).not.toHaveBeenCalled();
      await server.close();
    });

    it('триггер 3: Steam недоступен (5xx/429/circuit breaker) — completeVerification бросает ProviderError', async () => {
      const { server, deps } = serverWith({
        providers: new Map([
          [
            'steam' as const,
            {
              id: 'steam' as const,
              capabilities: { verification: 'steam-openid' as const, rank: 'api' as const },
              completeVerification: vi.fn(async () => {
                throw new ProviderError('steam недоступен: HTTP 503', 'steam');
              }),
              fetchProfile: vi.fn(),
            },
          ],
        ]),
      } as never);

      const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

      expectSafePage(response);
      // ProviderError — не UserError: внутренние детали («HTTP 503») не должны доехать
      // до игрока, только обобщённая формулировка (describeForUser).
      expect(response.body).not.toContain('503');
      expect(response.body).not.toContain('HTTP');
      expect(response.body).toContain('недоступен');
      expect(deps.notify).not.toHaveBeenCalled();
      await server.close();
    });
  });
});
