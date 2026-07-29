import { describe, expect, it, vi } from 'vitest';
import type { Cooldown, CooldownVerdict } from '../../../../src/core/cooldown.js';
import { ProviderError, UserError } from '../../../../src/core/errors.js';
import { EventBus } from '../../../../src/core/events/bus.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { Config } from '../../../../src/core/config.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createRankSyncCommand } from '../../../../src/modules/identity/commands/ranksync.js';
import type { RankInfo } from '../../../../src/modules/identity/providers/provider.js';
import type { GameAccountRow, LinkingService } from '../../../../src/modules/identity/services/linking.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

/** Та же заглушка, что и в link.test.ts/unlink.test.ts — намеренно не расходится по форме. */
function linkingStub() {
  return {
    ensureUser: vi.fn(async () => {}),
    openChallenge: vi.fn(async () => {}),
    takeChallenge: vi.fn(),
    pendingChallenge: vi.fn<LinkingService['pendingChallenge']>(async () => null),
    linkAccount: vi.fn<LinkingService['linkAccount']>(async () => 1),
    unlinkAccount: vi.fn(async () => true),
    listAccounts: vi.fn<LinkingService['listAccounts']>(async () => []),
    saveRank: vi.fn(async () => {}),
    latestRanks: vi.fn(async () => []),
    rankAt: vi.fn(async () => null),
  };
}

/** Строка game_accounts — тот же хелпер, что и в unlink.test.ts. */
function accountRow(provider: GameAccountRow['provider']): GameAccountRow {
  const now = new Date();
  return {
    id: 1,
    userId: '222222222222222222',
    provider,
    externalId: 'external-id',
    displayName: 'Игрок',
    region: null,
    verifiedAt: now,
    verificationMethod: 'manual',
    createdAt: now,
    updatedAt: now,
  };
}

function rank(tier: string): RankInfo {
  return { mode: 'dota-mmr', scale: 'dota-mmr', tier, division: null, points: null, source: 'api', raw: {} };
}

/** Кулдаун-заглушка с фиксированным вердиктом — по умолчанию всегда разрешает. */
function cooldownStub(verdict: CooldownVerdict = { allowed: true, retryAfterMs: 0 }): Cooldown {
  return {
    hit: vi.fn(async () => verdict),
    close: vi.fn(async () => {}),
  };
}

function depsWith(linking = linkingStub(), cooldown: Cooldown = cooldownStub()) {
  return {
    linking,
    providers: new Map(),
    roles: { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) },
    rankSync: { syncAccount: vi.fn(async () => []) },
    bus: new EventBus(logger),
    cooldown,
  };
}

describe('/ranksync', () => {
  it('делает defer эфемерно — ходит к провайдерам по сети', () => {
    const command = createRankSyncCommand(depsWith() as never);
    expect(command.defer).toEqual({ ephemeral: true });
  });

  it('без привязанных аккаунтов не тратит кулдаун — повторный вызов сразу после тоже не жалуется на кулдаун', async () => {
    const linking = linkingStub(); // listAccounts всегда возвращает []
    let hitCalls = 0;
    const cooldown: Cooldown = {
      hit: vi.fn(async () => {
        hitCalls += 1;
        return { allowed: true, retryAfterMs: 0 };
      }),
      close: vi.fn(async () => {}),
    };
    const command = createRankSyncCommand(depsWith(linking, cooldown) as never);

    // Проверяем не только текст, но и тип: роутер показывает текст UserError игроку как
    // есть, а любую другую ошибку заменяет кодом инцидента. Тест только на подстроку
    // прошёл бы и на голом Error, при котором игрок вместо подсказки «начни с /link»
    // увидел бы «сломалось на нашей стороне». Ловим руками, а не двумя rejects подряд,
    // чтобы не выполнять execute лишний раз и не тратить кулдаун там, где его считаем.
    const first = fakeChatInputInteraction('ranksync');
    const firstError = await command.execute(first.interaction, ctx).catch((e: unknown) => e);
    expect(firstError).toBeInstanceOf(UserError);
    expect((firstError as Error).message).toMatch(/link steam/);

    const second = fakeChatInputInteraction('ranksync');
    const secondError = await command.execute(second.interaction, ctx).catch((e: unknown) => e);
    expect(secondError).toBeInstanceOf(UserError);
    expect((secondError as Error).message).toMatch(/link steam/);

    // Если бы кулдаун тратился до проверки привязок (старый порядок, находка 7),
    // hit был бы вызван хотя бы раз — тут же до него дело не доходит вообще, ни разу.
    expect(hitCalls).toBe(0);
  });

  it('кулдаун реально работает между двумя последовательными вызовами, когда привязки есть', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    // Честная, а не замоканная заранее реализация: второй hit подряд обязан
    // увидеть, что окно ещё не истекло, и отказать — как настоящий Cooldown на Redis.
    let usedAt: number | null = null;
    const cooldown: Cooldown = {
      hit: vi.fn(async (_key: string, windowMs: number) => {
        const now = Date.now();
        if (usedAt !== null && now - usedAt < windowMs) {
          return { allowed: false, retryAfterMs: windowMs - (now - usedAt) };
        }
        usedAt = now;
        return { allowed: true, retryAfterMs: 0 };
      }),
      close: vi.fn(async () => {}),
    };
    const command = createRankSyncCommand(depsWith(linking, cooldown) as never);

    const first = fakeChatInputInteraction('ranksync');
    await command.execute(first.interaction, ctx);
    expect(first.calls.followUp).toHaveBeenCalled();

    const second = fakeChatInputInteraction('ranksync');
    await expect(command.execute(second.interaction, ctx)).rejects.toThrow(/попробуй через/);
  });

  it('кулдаун сообщает точное время ожидания в минутах', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    const cooldown = cooldownStub({ allowed: false, retryAfterMs: 245_000 }); // 4 мин 5 с → округление вверх до 5
    const command = createRankSyncCommand(depsWith(linking, cooldown) as never);
    const { interaction } = fakeChatInputInteraction('ranksync');

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/5 мин/);
    expect(cooldown.hit).toHaveBeenCalledWith('ranksync:222222222222222222', 10 * 60 * 1_000);
  });

  it('успешный прогон сообщает сколько аккаунтов проверено и сколько получили ранг', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam'), accountRow('riot-lol')]);
    const rankSync = {
      syncAccount: vi.fn(async (account: GameAccountRow) => (account.provider === 'steam' ? [rank('LEGEND')] : [])),
    };
    const command = createRankSyncCommand({ ...depsWith(linking), rankSync } as never);
    const { interaction, calls } = fakeChatInputInteraction('ranksync');

    await command.execute(interaction, ctx);

    expect(calls.followUp.mock.calls[0]?.[0]?.content).toBe('Проверено аккаунтов: 2, с рангом: 1.');
  });

  it('сбой провайдера (ProviderError) не путается с «рангов нет» — игрок видит понятную причину недоступности', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('riot-lol')]);
    const rankSync = {
      syncAccount: vi.fn(async () => {
        throw new ProviderError('внутренний текст, который игрок никогда не видит', 'riot-lol');
      }),
    };
    const command = createRankSyncCommand({ ...depsWith(linking), rankSync } as never);
    const { interaction, calls } = fakeChatInputInteraction('ranksync');

    // Не должно бросать — сбой одного провайдера не должен ронять всю команду.
    await command.execute(interaction, ctx);

    const content = calls.followUp.mock.calls[0]?.[0]?.content as string;
    // Честно: 0 действительно получили обновлённый ранг за этот вызов.
    expect(content).toContain('Проверено аккаунтов: 1, с рангом: 0');
    // Но это не должно выглядеть как «у тебя просто нет рангов» — рядом обязано
    // быть объяснение, что сервис недоступен, а не наш баг.
    expect(content).toContain('недоступен');
    expect(content).not.toContain('Что-то сломалось');
  });

  it('технический сбой одного аккаунта не мешает проверить остальные', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('riot-lol'), accountRow('steam')]);
    const rankSync = {
      syncAccount: vi.fn(async (account: GameAccountRow) => {
        if (account.provider === 'riot-lol') throw new Error('boom');
        return [rank('LEGEND')];
      }),
    };
    const command = createRankSyncCommand({ ...depsWith(linking), rankSync } as never);
    const { interaction, calls } = fakeChatInputInteraction('ranksync');

    await command.execute(interaction, ctx);

    expect(calls.followUp.mock.calls[0]?.[0]?.content).toContain('Проверено аккаунтов: 2, с рангом: 1');
  });
});
