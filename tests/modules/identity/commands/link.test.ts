import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import { EventBus } from '../../../../src/core/events/bus.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { Config } from '../../../../src/core/config.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createLinkCommand } from '../../../../src/modules/identity/commands/link.js';
import { createValorantProvider } from '../../../../src/modules/identity/providers/valorant.js';
import type { GameProvider } from '../../../../src/modules/identity/providers/provider.js';
import type { ProviderId } from '../../../../src/modules/identity/schema.js';
import type { LinkingService } from '../../../../src/modules/identity/services/linking.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

function linkingStub() {
  return {
    ensureUser: vi.fn(async () => {}),
    openChallenge: vi.fn(async () => {}),
    takeChallenge: vi.fn(),
    // Явный тип-параметр обязателен: без него vi.fn выводит сигнатуру из нульарного
    // литерала (() => Promise<null>), и переприсваивание в тестах ниже (на другую
    // форму возврата) не пройдёт тайпчек — вывод типа не видит реальный контракт
    // LinkingService.pendingChallenge, только форму конкретного переданного лямбда.
    pendingChallenge: vi.fn<LinkingService['pendingChallenge']>(async () => null),
    // Аналогично: без явного типа .mock.calls[n] выводится как пустой кортеж
    // (аргументы лямбда () => Promise<number> — ноль), и call[1] ниже не компилируется.
    linkAccount: vi.fn<LinkingService['linkAccount']>(async () => 1),
    unlinkAccount: vi.fn(async () => true),
    listAccounts: vi.fn(async () => []),
    saveRank: vi.fn(async () => {}),
    latestRanks: vi.fn(async () => []),
    rankAt: vi.fn(async () => null),
  };
}

function depsWith(providers: Array<[ProviderId, GameProvider]>, linking = linkingStub()) {
  return {
    linking,
    providers: new Map(providers),
    roles: { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) },
    rankSync: { syncAccount: vi.fn(async () => []) },
    bus: new EventBus(logger),
  };
}

/** Расширяет фейк интеракции чтением строковых опций и подкоманды. */
function interactionWithOptions(subcommand: string, options: Record<string, string>) {
  const fake = fakeChatInputInteraction('link');
  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getSubcommand: () => subcommand,
      getString: (name: string, required?: boolean) => {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
    },
  });
  return fake;
}

const steamProvider: GameProvider = {
  id: 'steam',
  capabilities: { verification: 'steam-openid', rank: 'api' },
  startVerification: async () => ({
    challenge: 'НОНС-1',
    expiresAt: new Date(Date.now() + 60_000),
    payload: {},
    instruction: 'Открой ссылку https://steamcommunity.com/openid/login?x=1',
  }),
  completeVerification: async () => ({ externalId: '765', displayName: 'a', verificationMethod: 'steam-openid' }),
  fetchProfile: async () => ({ externalId: '765', displayName: 'a' }),
};

describe('/link', () => {
  it('объявляет подкоманду на каждый способ привязки', () => {
    const command = createLinkCommand(depsWith([]) as never);
    const json = command.builder.toJSON();
    expect(json.options?.map((o) => o.name).sort()).toEqual(['genshin', 'riot', 'steam', 'valorant']);
  });

  it('делает defer эфемерно — внутри сетевые вызовы', () => {
    const command = createLinkCommand(depsWith([]) as never);
    expect(command.defer).toEqual({ ephemeral: true });
  });

  it('для steam открывает челлендж и показывает инструкцию', async () => {
    const linking = linkingStub();
    const command = createLinkCommand(depsWith([['steam', steamProvider]], linking) as never);
    const { interaction, calls } = interactionWithOptions('steam', {});

    await command.execute(interaction, ctx);

    expect(linking.openChallenge).toHaveBeenCalledWith('222222222222222222', 'steam', expect.any(Object));
    const content = calls.followUp.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('steamcommunity.com/openid/login');
  });

  it('для valorant сохраняет ручной ранг и помечает как неподтверждённый', async () => {
    const linking = linkingStub();
    const command = createLinkCommand(
      depsWith([['riot-valorant', createValorantProvider()]], linking) as never,
    );
    const { interaction } = interactionWithOptions('valorant', { 'riot-id': 'Игрок#EUW', rank: 'Immortal 2' });

    await command.execute(interaction, ctx);

    expect(linking.linkAccount).toHaveBeenCalledWith(
      '222222222222222222',
      'riot-valorant',
      expect.objectContaining({ externalId: 'Игрок#EUW', verificationMethod: 'manual' }),
      false,
    );
    expect(linking.saveRank).toHaveBeenCalledWith(1, expect.objectContaining({ tier: 'IMMORTAL', source: 'manual' }));
  });

  it('для valorant отвергает непонятный ранг', async () => {
    const command = createLinkCommand(depsWith([['riot-valorant', createValorantProvider()]]) as never);
    const { interaction } = interactionWithOptions('valorant', { 'riot-id': 'Игрок#EUW', rank: 'очень высокий' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('для riot на первом вызове выдаёт код, а не привязывает', async () => {
    const linking = linkingStub();
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({
        challenge: 'ABCD2345',
        expiresAt: new Date(Date.now() + 60_000),
        payload: {},
        instruction: 'Вставь код ABCD2345 в клиент',
      }),
      completeVerification: async () => ({ externalId: 'P', displayName: 'a#b', verificationMethod: 'riot-third-party-code' }),
      fetchProfile: async () => ({ externalId: 'P', displayName: 'a#b' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction, calls } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await command.execute(interaction, ctx);

    expect(linking.linkAccount).not.toHaveBeenCalled();
    expect(calls.followUp.mock.calls[0]?.[0]?.content).toContain('ABCD2345');
  });

  it('для riot на втором вызове проверяет код и привязывает', async () => {
    const linking = linkingStub();
    linking.pendingChallenge = vi.fn<LinkingService['pendingChallenge']>(async () => ({
      challenge: 'ABCD2345',
      payload: { platform: 'euw1' },
    }));
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification: async () => ({
        externalId: 'PUUID-1',
        displayName: 'Игрок#EUW',
        region: 'euw1',
        verificationMethod: 'riot-third-party-code',
      }),
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#EUW' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await command.execute(interaction, ctx);

    expect(linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-lol', expect.any(Object), true);
  });

  it('для riot привязывает и TFT тем же подтверждением', async () => {
    const linking = linkingStub();
    linking.pendingChallenge = vi.fn<LinkingService['pendingChallenge']>(async () => ({
      challenge: 'ABCD2345',
      payload: { platform: 'euw1' },
    }));
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification: async () => ({
        externalId: 'PUUID-1',
        displayName: 'Игрок#EUW',
        region: 'euw1',
        verificationMethod: 'riot-third-party-code',
      }),
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#EUW' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await command.execute(interaction, ctx);

    const providers = linking.linkAccount.mock.calls.map((call) => call[1]);
    expect(providers).toEqual(['riot-lol', 'riot-tft']);
  });

  it('на подтверждающем вызове использует платформу текущего вызова, а не сохранённую в первом', async () => {
    const linking = linkingStub();
    // Игрок ошибся в платформе на первом вызове — в payload сохранён euw1.
    linking.pendingChallenge = vi.fn<LinkingService['pendingChallenge']>(async () => ({
      challenge: 'ABCD2345',
      payload: { platform: 'euw1' },
    }));
    const completeVerification = vi.fn(async () => ({
      externalId: 'PUUID-1',
      displayName: 'Игрок#RU',
      region: 'ru',
      verificationMethod: 'riot-third-party-code' as const,
    }));
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification,
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#RU' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    // На подтверждающем вызове игрок указывает верную платформу ru — она должна
    // дойти до completeVerification вместо сохранённой (ошибочной) euw1.
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#RU', platform: 'ru' });

    await command.execute(interaction, ctx);

    expect(completeVerification).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ platform: 'ru' }) }),
      'Игрок#RU',
    );
  });

  it('riot: при сбое второй привязки (TFT) сообщает, что LoL уже привязан, а не только голую ошибку', async () => {
    const linking = linkingStub();
    linking.pendingChallenge = vi.fn<LinkingService['pendingChallenge']>(async () => ({
      challenge: 'ABCD2345',
      payload: { platform: 'euw1' },
    }));
    linking.linkAccount = vi.fn<LinkingService['linkAccount']>(async (_userId, providerId) => {
      if (providerId === 'riot-tft') {
        throw new UserError('Этот игровой аккаунт уже привязан к другому пользователю сервера.');
      }
      return 1;
    });
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification: async () => ({
        externalId: 'PUUID-1',
        displayName: 'Игрок#EUW',
        region: 'euw1',
        verificationMethod: 'riot-third-party-code',
      }),
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#EUW' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction, calls } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    // Не должно бросать: частичный успех обрабатывается как ответ, а не исключение.
    await command.execute(interaction, ctx);

    expect(linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-lol', expect.any(Object), true);
    expect(linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-tft', expect.any(Object), true);
    const content = calls.followUp.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('LoL');
    expect(content).toContain('TFT');
    expect(content).not.toMatch(/^Готово/);
  });

  it('riot: если не привязался даже первый провайдер (LoL), пробрасывает ошибку как обычно', async () => {
    const linking = linkingStub();
    linking.pendingChallenge = vi.fn<LinkingService['pendingChallenge']>(async () => ({
      challenge: 'ABCD2345',
      payload: { platform: 'euw1' },
    }));
    linking.linkAccount = vi.fn<LinkingService['linkAccount']>(async () => {
      throw new UserError('Этот игровой аккаунт уже привязан к другому пользователю сервера.');
    });
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification: async () => ({
        externalId: 'PUUID-1',
        displayName: 'Игрок#EUW',
        region: 'euw1',
        verificationMethod: 'riot-third-party-code',
      }),
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#EUW' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('отвергает неизвестную платформу Riot до обращения к API', async () => {
    const command = createLinkCommand(depsWith([]) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'марс1' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('сообщает понятной ошибкой, что провайдер не подключён', async () => {
    const command = createLinkCommand(depsWith([]) as never);
    const { interaction } = interactionWithOptions('steam', {});

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });
});
