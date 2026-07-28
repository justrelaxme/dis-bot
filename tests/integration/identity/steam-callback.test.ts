import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSteamCallback } from '../../../src/modules/identity/http/steam-callback.js';
import { createLogger } from '../../../src/core/logger.js';
import type { Config } from '../../../src/core/config.js';

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
});
