import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createRouter } from '../../src/core/commands/router.js';
import { UserError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { createMetrics } from '../../src/core/metrics.js';
import type { ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { fakeChatInputInteraction } from '../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

function routerFor(execute: () => Promise<void>, defer?: { ephemeral: boolean }) {
  const registry = buildRegistry([
    {
      name: 'test',
      commands: [
        {
          builder: new SlashCommandBuilder().setName('cmd').setDescription('тест'),
          ...(defer ? { defer } : {}),
          execute,
        },
      ],
    },
  ]);
  return createRouter({ registry, ctx, metrics: createMetrics() });
}

describe('createRouter', () => {
  it('вызывает обработчик найденной команды', async () => {
    const execute = vi.fn(async () => {});
    const route = routerFor(execute);
    const { interaction } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(execute).toHaveBeenCalledOnce();
  });

  it('делает deferReply до обработчика, когда команда так объявлена', async () => {
    const order: string[] = [];
    const route = routerFor(async () => {
      order.push('execute');
    }, { ephemeral: true });
    const { interaction, calls } = fakeChatInputInteraction('cmd');
    calls.deferReply.mockImplementation(async () => {
      order.push('defer');
    });

    await route(interaction);

    expect(order).toEqual(['defer', 'execute']);
  });

  it('показывает текст UserError пользователю дословно', async () => {
    const route = routerFor(async () => {
      throw new UserError('Аккаунт уже привязан.');
    });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(calls.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Аккаунт уже привязан.' }),
    );
  });

  it('превращает неожиданную ошибку в код инцидента', async () => {
    const route = routerFor(async () => {
      throw new Error('обращение к null');
    });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    const content = calls.reply.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('Код инцидента');
    expect(content).not.toContain('обращение к null');
  });

  it('отвечает через followUp, если уже был deferReply', async () => {
    const route = routerFor(async () => {
      throw new Error('поломка');
    }, { ephemeral: true });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(calls.followUp).toHaveBeenCalled();
    expect(calls.reply).not.toHaveBeenCalled();
  });

  it('игнорирует интеракцию неизвестной команды без падения', async () => {
    const route = routerFor(async () => {});
    const { interaction, calls } = fakeChatInputInteraction('нет-такой');

    await expect(route(interaction)).resolves.toBeUndefined();
    expect(calls.reply).not.toHaveBeenCalled();
  });
});
