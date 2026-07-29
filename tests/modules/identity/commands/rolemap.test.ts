import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createRoleMapCommand } from '../../../../src/modules/identity/commands/rolemap.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const ctx = { logger: createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config) } as unknown as ModuleContext;

function depsWith() {
  return {
    roles: {
      setMapping: vi.fn(async () => {}),
      listMappings: vi.fn(async () => [
        { id: 1, guildId: '111111111111111111', provider: 'riot-lol', mode: 'solo-duo', tier: 'GOLD', roleId: '400000000000000001' },
      ]),
      removeMapping: vi.fn(async () => true),
      resolveDesiredRoles: vi.fn(),
      applyRoles: vi.fn(),
    },
  };
}

/**
 * Гильдия с ботом-участником: permissions.has и roles.highest.position — ровно то,
 * что rolemap.ts проверяет перед записью маппинга (находка 4). Дефолт представляет
 * «здоровый» сервер: у бота есть Manage Roles, и его роль выше типичной роли ранга.
 */
function fakeGuild(overrides: { managePermission?: boolean; botHighestPosition?: number } = {}) {
  const managePermission = overrides.managePermission ?? true;
  const botHighestPosition = overrides.botHighestPosition ?? 10;
  return {
    id: '111111111111111111',
    members: {
      me: {
        permissions: { has: () => managePermission },
        roles: { highest: { position: botHighestPosition } },
      },
    },
  };
}

function interactionWith(
  subcommand: string,
  strings: Record<string, string>,
  roleId?: string,
  roleOverrides: { position?: number; managed?: boolean } = {},
  guild: unknown = fakeGuild(),
) {
  const fake = fakeChatInputInteraction('rolemap');
  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getSubcommand: () => subcommand,
      getString: (name: string, required?: boolean) => {
        const value = strings[name] ?? null;
        if (required && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
      getRole: () =>
        roleId
          ? { id: roleId, name: 'Роль', position: roleOverrides.position ?? 1, managed: roleOverrides.managed ?? false }
          : null,
    },
  });
  Object.defineProperty(fake.interaction, 'guild', { value: guild, configurable: true });
  return fake;
}

describe('/rolemap', () => {
  it('требует права управления ролями', () => {
    const command = createRoleMapCommand(depsWith() as never);
    const json = command.builder.toJSON();
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageRoles));
  });

  it('объявляет подкоманды set, list и remove', () => {
    const command = createRoleMapCommand(depsWith() as never);
    const json = command.builder.toJSON();
    expect(json.options?.map((o) => o.name).sort()).toEqual(['list', 'remove', 'set']);
  });

  it('делает defer эфемерно — list/set/remove читают БД до первого ответа', () => {
    const command = createRoleMapCommand(depsWith() as never);
    expect(command.defer).toEqual({ ephemeral: true });
  });

  it('добавляет tft-double-up в список допустимых режимов команды', () => {
    // JSON.stringify вместо типизированного обхода options/choices: у ApplicationCommandOption
    // в discord.js это union, где choices есть только у части подтипов — проверка глубокого
    // пути потребовала бы кастов сильнее, чем то, что реально нужно доказать здесь.
    const command = createRoleMapCommand(depsWith() as never);
    const json = command.builder.toJSON();
    expect(JSON.stringify(json)).toContain('tft-double-up');
  });

  it('сохраняет маппинг с нормализованным тиром в верхнем регистре', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'platinum' },
      '400000000000000002',
    );

    await command.execute(interaction, ctx);

    expect(deps.roles.setMapping).toHaveBeenCalledWith(
      '111111111111111111',
      'riot-lol',
      'solo-duo',
      'PLATINUM',
      '400000000000000002',
    );
  });

  it('отвергает тир, которого нет в шкале провайдера', async () => {
    const command = createRoleMapCommand(depsWith() as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'МИФИЧЕСКИЙ' },
      '400000000000000002',
    );

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('отвергает тир Dota для провайдера Riot', async () => {
    const command = createRoleMapCommand(depsWith() as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'HERALD' },
      '400000000000000002',
    );

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/IRON/);
  });

  it('отвергает режим, не подходящий провайдеру, даже если тир валиден (steam + solo-duo)', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    // LEGEND — настоящая медаль Dota (валиден для steam), а solo-duo — режим LoL:
    // для steam такой пары не бывает.
    const { interaction } = interactionWith(
      'set',
      { provider: 'steam', mode: 'solo-duo', tier: 'LEGEND' },
      '400000000000000002',
    );

    const result = command.execute(interaction, ctx);
    await expect(result).rejects.toThrow(UserError);
    await expect(result).rejects.toThrow(/режим/);
    expect(deps.roles.setMapping).not.toHaveBeenCalled();
  });

  it('принимает tft-double-up как валидный режим для riot-tft', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-tft', mode: 'tft-double-up', tier: 'GOLD' },
      '400000000000000002',
    );

    await command.execute(interaction, ctx);

    expect(deps.roles.setMapping).toHaveBeenCalledWith(
      '111111111111111111',
      'riot-tft',
      'tft-double-up',
      'GOLD',
      '400000000000000002',
    );
  });

  it('отклоняет роль, которой бот не может управлять из-за иерархии, и не пишет маппинг', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const guild = fakeGuild({ botHighestPosition: 10 });
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'PLATINUM' },
      '400000000000000002',
      { position: 15 }, // выше бота
      guild,
    );

    const result = command.execute(interaction, ctx);
    await expect(result).rejects.toThrow(UserError);
    await expect(result).rejects.toThrow(/списке ролей сервера/);
    expect(deps.roles.setMapping).not.toHaveBeenCalled();
  });

  it('отклоняет managed-роль интеграции/буста и не пишет маппинг', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'PLATINUM' },
      '400000000000000002',
      { managed: true },
    );

    const result = command.execute(interaction, ctx);
    await expect(result).rejects.toThrow(UserError);
    await expect(result).rejects.toThrow(/интеграци/);
    expect(deps.roles.setMapping).not.toHaveBeenCalled();
  });

  it('отклоняет настройку, если у бота нет права «Управление ролями», и не пишет маппинг', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const guild = fakeGuild({ managePermission: false });
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'PLATINUM' },
      '400000000000000002',
      {},
      guild,
    );

    const result = command.execute(interaction, ctx);
    await expect(result).rejects.toThrow(UserError);
    await expect(result).rejects.toThrow(/Управление ролями/);
    expect(deps.roles.setMapping).not.toHaveBeenCalled();
  });

  it('перечисляет существующие маппинги', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction, calls } = interactionWith('list', {});

    await command.execute(interaction, ctx);

    const content = calls.followUp.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('GOLD');
    expect(content).toContain('<@&400000000000000001>');
  });

  it('сообщает, когда маппингов нет', async () => {
    const deps = depsWith();
    deps.roles.listMappings = vi.fn(async () => []);
    const command = createRoleMapCommand(deps as never);
    const { interaction, calls } = interactionWith('list', {});

    await command.execute(interaction, ctx);

    expect(calls.followUp.mock.calls[0]?.[0]?.content).toContain('пока не настроены');
  });

  it('удаляет маппинг и сообщает, если его не было', async () => {
    const deps = depsWith();
    deps.roles.removeMapping = vi.fn(async () => false);
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith('remove', { provider: 'riot-lol', mode: 'solo-duo', tier: 'GOLD' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/не найден/);
  });
});
