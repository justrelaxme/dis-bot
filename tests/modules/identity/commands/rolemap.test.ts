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

function interactionWith(subcommand: string, strings: Record<string, string>, roleId?: string) {
  const fake = fakeChatInputInteraction('rolemap');
  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getSubcommand: () => subcommand,
      getString: (name: string, required?: boolean) => {
        const value = strings[name] ?? null;
        if (required && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
      getRole: () => (roleId ? { id: roleId, name: 'Роль' } : null),
    },
  });
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

  it('перечисляет существующие маппинги', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction, calls } = interactionWith('list', {});

    await command.execute(interaction, ctx);

    const content = calls.reply.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('GOLD');
    expect(content).toContain('<@&400000000000000001>');
  });

  it('сообщает, когда маппингов нет', async () => {
    const deps = depsWith();
    deps.roles.listMappings = vi.fn(async () => []);
    const command = createRoleMapCommand(deps as never);
    const { interaction, calls } = interactionWith('list', {});

    await command.execute(interaction, ctx);

    expect(calls.reply.mock.calls[0]?.[0]?.content).toContain('пока не настроены');
  });

  it('удаляет маппинг и сообщает, если его не было', async () => {
    const deps = depsWith();
    deps.roles.removeMapping = vi.fn(async () => false);
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith('remove', { provider: 'riot-lol', mode: 'solo-duo', tier: 'GOLD' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/не найден/);
  });
});
