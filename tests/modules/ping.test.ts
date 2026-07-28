import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ModuleContext } from '../../src/core/module.js';
import { pingModule } from '../../src/modules/ping/index.js';
import { fakeChatInputInteraction } from '../helpers/interaction.js';

describe('модуль ping', () => {
  it('объявляет одну команду /ping', () => {
    expect(pingModule.commands).toHaveLength(1);
    expect(pingModule.commands?.[0]?.builder.name).toBe('ping');
  });

  it('отвечает задержкой шлюза эфемерно', async () => {
    const { interaction, calls } = fakeChatInputInteraction('ping');
    Object.defineProperty(interaction, 'client', { value: { ws: { ping: 42 } } });

    await pingModule.commands?.[0]?.execute(interaction, {} as ModuleContext);

    const payload = calls.reply.mock.calls[0]?.[0] as { content: string; flags: number };
    expect(payload.content).toContain('42');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('не требует defer — ответ мгновенный', () => {
    expect(pingModule.commands?.[0]?.defer).toBeUndefined();
  });
});
