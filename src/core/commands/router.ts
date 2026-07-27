import { MessageFlags, type Interaction } from 'discord.js';
import { describeForUser } from '../errors.js';
import type { Metrics } from '../metrics.js';
import type { ModuleContext } from '../module.js';
import type { Registry } from '../registry.js';

export interface RouterDeps {
  registry: Registry;
  ctx: ModuleContext;
  metrics: Metrics;
}

export function createRouter(deps: RouterDeps): (interaction: Interaction) => Promise<void> {
  const { registry, ctx, metrics } = deps;

  return async function route(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const entry = registry.commands.get(interaction.commandName);
    if (!entry) {
      ctx.logger.warn({ command: interaction.commandName }, 'интеракция неизвестной команды');
      return;
    }

    const log = ctx.logger.child({
      command: interaction.commandName,
      module: entry.moduleName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      correlationId: interaction.id,
    });
    const stopTimer = metrics.commandDuration.startTimer({ command: interaction.commandName });

    try {
      if (entry.command.defer) {
        await interaction.deferReply(
          entry.command.defer.ephemeral ? { flags: MessageFlags.Ephemeral } : {},
        );
      }
      await entry.command.execute(interaction, ctx);
      stopTimer({ outcome: 'ok' });
      log.info('команда выполнена');
    } catch (error) {
      stopTimer({ outcome: 'error' });
      const described = describeForUser(error);

      if (described.incidentId) {
        log.error({ err: error, incidentId: described.incidentId }, 'команда упала');
      } else {
        log.info({ err: error }, 'команда завершилась ожидаемой ошибкой');
      }

      await respond(interaction, described.text, log);
    }
  };
}

async function respond(interaction: Interaction, content: string, log: ModuleContext['logger']): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    // Окно ответа могло закрыться — сообщить пользователю больше нечем.
    log.error({ err: error }, 'не удалось доставить сообщение об ошибке');
  }
}
