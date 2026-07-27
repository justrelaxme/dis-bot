import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createRouter } from '../../src/core/commands/router.js';
import { ProviderError, UserError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { createMetrics } from '../../src/core/metrics.js';
import type { CommandDefinition, ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { fakeChatInputInteraction } from '../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

function routerFor(execute: CommandDefinition['execute'], defer?: { ephemeral: boolean }) {
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

  it('игнорирует интеракцию, не являющуюся slash-командой', async () => {
    const route = routerFor(async () => {});
    const { interaction, calls } = fakeChatInputInteraction('cmd');
    Object.defineProperty(interaction, 'isChatInputCommand', { value: () => false });

    await expect(route(interaction)).resolves.toBeUndefined();
    expect(calls.reply).not.toHaveBeenCalled();
    expect(calls.deferReply).not.toHaveBeenCalled();
  });

  it('превращает ProviderError в сообщение о недоступности сервиса без внутренних деталей', async () => {
    const route = routerFor(async () => {
      throw new ProviderError('502 Bad Gateway от upstream', 'riot-lol');
    });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    const content = calls.reply.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('riot-lol');
    expect(content).not.toContain('502');
    expect(content).not.toContain('Код инцидента');
  });

  it('не даёт упасть наружу, если само сообщение об ошибке не доставилось', async () => {
    // Окно ответа Discord могло закрыться. Сообщить пользователю больше нечем,
    // но исходная ошибка не должна быть заслонена ошибкой доставки.
    const route = routerFor(async () => {
      throw new Error('первичная поломка');
    });
    const { interaction, calls } = fakeChatInputInteraction('cmd');
    calls.reply.mockRejectedValue(new Error('окно ответа закрыто'));

    await expect(route(interaction)).resolves.toBeUndefined();
    expect(calls.reply).toHaveBeenCalled();
  });

  it('передаёт обработчику логгер с correlationId, а не корневой', async () => {
    // Иначе всё, что команда пишет сама, невозможно связать со строками роутера.
    let seen: ModuleContext | undefined;
    const route = routerFor(async (_interaction, handlerCtx) => {
      seen = handlerCtx;
    });
    const { interaction } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(seen).toBeDefined();
    expect(seen!.logger).not.toBe(ctx.logger);
    const bindings = (seen!.logger as unknown as { bindings(): Record<string, unknown> }).bindings();
    expect(bindings['correlationId']).toBe(interaction.id);
    expect(bindings['command']).toBe('cmd');
  });
});
