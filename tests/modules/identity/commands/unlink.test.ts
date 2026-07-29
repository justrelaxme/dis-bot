import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import { EventBus } from '../../../../src/core/events/bus.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { Config } from '../../../../src/core/config.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createUnlinkCommand } from '../../../../src/modules/identity/commands/unlink.js';
import type { ProviderId } from '../../../../src/modules/identity/schema.js';
import type { GameAccountRow, LinkingService } from '../../../../src/modules/identity/services/linking.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

/** Та же заглушка, что и в link.test.ts — намеренно не расходится по форме. */
function linkingStub() {
  return {
    ensureUser: vi.fn(async () => {}),
    openChallenge: vi.fn(async () => {}),
    takeChallenge: vi.fn(),
    pendingChallenge: vi.fn<LinkingService['pendingChallenge']>(async () => null),
    linkAccount: vi.fn<LinkingService['linkAccount']>(async () => 1),
    unlinkAccount: vi.fn(async () => true),
    // Явный тип-параметр обязателен (как у pendingChallenge/linkAccount выше): без
    // него vi.fn выводит сигнатуру из нульарного литерала () => Promise<never[]>,
    // и переприсваивание в тестах ниже (на непустой массив аккаунтов) не пройдёт тайпчек.
    listAccounts: vi.fn<LinkingService['listAccounts']>(async () => []),
    saveRank: vi.fn(async () => {}),
    latestRanks: vi.fn(async () => []),
    rankAt: vi.fn(async () => null),
  };
}

function depsWith(linking = linkingStub()) {
  return {
    linking,
    providers: new Map(),
    roles: { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) },
    rankSync: { syncAccount: vi.fn(async () => []) },
    bus: new EventBus(logger),
  };
}

/**
 * Строка game_accounts для стаба listAccounts. unlink.ts теперь читает её перед тем,
 * как трогать роли или БД, — чтобы узнать, какие провайдеры из запрошенной группы
 * (одиночный провайдер или пара riot-lol/riot-tft) реально привязаны сейчас.
 */
function accountRow(provider: ProviderId): GameAccountRow {
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

/**
 * DiscordAPIError с кодом Unknown Member — именно так discord.js сообщает, что
 * участник вышел с сервера между командами. unlink.ts обязан отличать этот случай
 * от настоящего сбоя (нет прав, недоступен Discord) — см. fetchMemberOrNull.
 */
function unknownMemberError(): DiscordAPIError {
  return new DiscordAPIError(
    { message: 'Unknown Member', code: RESTJSONErrorCodes.UnknownMember },
    RESTJSONErrorCodes.UnknownMember,
    404,
    'GET',
    '/guilds/111111111111111111/members/222222222222222222',
    { body: undefined, files: undefined },
  );
}

/**
 * Расширяет фейк интеракции чтением опции provider и подделывает interaction.guild —
 * unlink.ts проверяет именно guild (не guildId), чтобы решить, снимать ли роли.
 * guild = null имитирует вызов вне гильдии (например, в личных сообщениях бота).
 */
function interactionWithProvider(provider: string, guild: unknown = null) {
  const fake = fakeChatInputInteraction('unlink');
  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getString: (name: string, required?: boolean) => {
        if (name === 'provider') return provider;
        if (required) throw new Error(`опция ${name} обязательна`);
        return null;
      },
    },
  });
  Object.defineProperty(fake.interaction, 'guild', { value: guild, configurable: true });
  return fake;
}

describe('/unlink', () => {
  it('объявляет опцию provider', () => {
    const command = createUnlinkCommand(depsWith() as never);
    const json = command.builder.toJSON();
    expect(json.options?.map((o) => o.name)).toEqual(['provider']);
  });

  it('делает defer эфемерно — внутри сетевые вызовы', () => {
    const command = createUnlinkCommand(depsWith() as never);
    expect(command.defer).toEqual({ ephemeral: true });
  });

  it('успешно отвязывает и снимает роли за ранг пустым списком рангов', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    const roles = { applyRoles: vi.fn(async () => ({ added: [], removed: ['role-1'] })) };
    const fakeMember = { id: '222222222222222222' };
    const membersFetch = vi.fn(async () => fakeMember);
    const guild = { id: '111111111111111111', members: { fetch: membersFetch } };
    const command = createUnlinkCommand({ ...depsWith(linking), roles } as never);
    const { interaction, calls } = interactionWithProvider('steam', guild);

    await command.execute(interaction, ctx);

    expect(linking.unlinkAccount).toHaveBeenCalledWith('222222222222222222', 'steam');
    expect(membersFetch).toHaveBeenCalledWith('222222222222222222');
    // Пустой список рангов — это и есть механизм снятия ролей за ранг (applyRoles
    // трактует "нет рангов" как "ничего не должно быть назначено" и снимает управляемые роли).
    expect(roles.applyRoles).toHaveBeenCalledWith(fakeMember, '111111111111111111', 'steam', []);
    expect(calls.followUp.mock.calls[0]?.[0]?.content).toContain('сняты');
  });

  it('сообщает понятной ошибкой об отсутствии привязки и не трогает роли и БД', async () => {
    const linking = linkingStub();
    // listAccounts по умолчанию возвращает [] — привязки нет ни для одного провайдера.
    const roles = { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) };
    const guild = { id: '111111111111111111', members: { fetch: vi.fn() } };
    const command = createUnlinkCommand({ ...depsWith(linking), roles } as never);
    // guild намеренно присутствует: падение должно случиться раньше проверки
    // гильдии — иначе тест не отличил бы "нет привязки" от "нет гильдии".
    const { interaction } = interactionWithProvider('steam', guild);

    // Один и тот же промис проверяется дважды — execute() вызывается только один раз.
    const result = command.execute(interaction, ctx);
    await expect(result).rejects.toThrow(UserError);
    await expect(result).rejects.toThrow(/не было такой привязки/);
    expect(roles.applyRoles).not.toHaveBeenCalled();
    expect(linking.unlinkAccount).not.toHaveBeenCalled();
  });

  it('вне гильдии отвязывает, но не трогает роли и не падает', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    const roles = { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) };
    const command = createUnlinkCommand({ ...depsWith(linking), roles } as never);
    const { interaction } = interactionWithProvider('steam', null);

    await command.execute(interaction, ctx);

    expect(linking.unlinkAccount).toHaveBeenCalledWith('222222222222222222', 'steam');
    expect(roles.applyRoles).not.toHaveBeenCalled();
  });

  it('публикует account.unlinked с userId и provider', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    const bus = new EventBus(logger);
    const handler = vi.fn(async () => {});
    bus.on('account.unlinked', handler);
    const command = createUnlinkCommand({ ...depsWith(linking), bus } as never);
    const { interaction } = interactionWithProvider('steam', null);

    await command.execute(interaction, ctx);

    expect(handler).toHaveBeenCalledWith({ userId: '222222222222222222', provider: 'steam' });
  });

  it('riot-lol и riot-tft привязывались одним подтверждением — отвязываются одной командой', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('riot-lol'), accountRow('riot-tft')]);
    const roles = { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) };
    const fakeMember = { id: '222222222222222222' };
    const guild = { id: '111111111111111111', members: { fetch: vi.fn(async () => fakeMember) } };
    const bus = new EventBus(logger);
    const handler = vi.fn(async () => {});
    bus.on('account.unlinked', handler);
    const command = createUnlinkCommand({ ...depsWith(linking), roles, bus } as never);
    // Игрок просит отвязать только "League of Legends" — riot-tft снимается вместе с ним,
    // потому что обе привязки были созданы одним и тем же подтверждением /link riot.
    const { interaction, calls } = interactionWithProvider('riot-lol', guild);

    await command.execute(interaction, ctx);

    expect(linking.unlinkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-lol');
    expect(linking.unlinkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-tft');
    expect(roles.applyRoles).toHaveBeenCalledWith(fakeMember, '111111111111111111', 'riot-lol', []);
    expect(roles.applyRoles).toHaveBeenCalledWith(fakeMember, '111111111111111111', 'riot-tft', []);
    expect(handler).toHaveBeenCalledWith({ userId: '222222222222222222', provider: 'riot-lol' });
    expect(handler).toHaveBeenCalledWith({ userId: '222222222222222222', provider: 'riot-tft' });
    expect(calls.followUp.mock.calls[0]?.[0]?.content).not.toContain('и так не было привязано');
  });

  it('пара riot неполная (старый частичный сбой /link riot) — отвязывает только то, что реально есть, и честно об этом сообщает', async () => {
    const linking = linkingStub();
    // riot-tft отсутствует — например, из-за прошлого частичного сбоя привязки пары.
    linking.listAccounts = vi.fn(async () => [accountRow('riot-lol')]);
    const roles = { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) };
    const command = createUnlinkCommand({ ...depsWith(linking), roles } as never);
    // Запрашиваем именно riot-tft — которого нет, но riot-lol из той же пары есть.
    const { interaction, calls } = interactionWithProvider('riot-tft', null);

    await command.execute(interaction, ctx);

    expect(linking.unlinkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-lol');
    expect(linking.unlinkAccount).not.toHaveBeenCalledWith('222222222222222222', 'riot-tft');
    const content = calls.followUp.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('Teamfight Tactics');
    expect(content).toContain('не было привязано');
  });

  it('участник вышел с сервера между командами — отвязывает без попытки снять роли и не падает', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    const roles = { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) };
    const membersFetch = vi.fn(async () => {
      throw unknownMemberError();
    });
    const guild = { id: '111111111111111111', members: { fetch: membersFetch } };
    const command = createUnlinkCommand({ ...depsWith(linking), roles } as never);
    const { interaction } = interactionWithProvider('steam', guild);

    await command.execute(interaction, ctx);

    expect(roles.applyRoles).not.toHaveBeenCalled();
    expect(linking.unlinkAccount).toHaveBeenCalledWith('222222222222222222', 'steam');
  });

  it('сбой снятия ролей (нет прав/иерархия) не удаляет привязку и не публикует событие', async () => {
    const linking = linkingStub();
    linking.listAccounts = vi.fn(async () => [accountRow('steam')]);
    const roles = {
      applyRoles: vi.fn(async () => {
        throw new Error('Missing Permissions');
      }),
    };
    const fakeMember = { id: '222222222222222222' };
    const guild = { id: '111111111111111111', members: { fetch: vi.fn(async () => fakeMember) } };
    const bus = new EventBus(logger);
    const handler = vi.fn(async () => {});
    bus.on('account.unlinked', handler);
    const command = createUnlinkCommand({ ...depsWith(linking), roles, bus } as never);
    const { interaction } = interactionWithProvider('steam', guild);

    // Состояние обязано остаться согласованным: ни БД, ни событие не должны
    // измениться, пока роли не снялись успешно.
    const result = command.execute(interaction, ctx);
    await expect(result).rejects.toThrow(UserError);
    await expect(result).rejects.toThrow(/роли/);
    expect(linking.unlinkAccount).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
