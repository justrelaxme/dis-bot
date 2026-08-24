import type { Interaction } from 'discord.js';
import type { EventHandler } from '../../../core/module.js';
import type { FormatsService } from '../services/formats.js';

/**
 * Автодополнение имён сохранённых форматов.
 *
 * Отдельным обработчиком, а не в роутере ядра: роутер обслуживает slash-команды, у которых
 * есть отложенный ответ, обработка ошибок и метрики. У автодополнения ничего этого не бывает
 * — Discord ждёт ответ три секунды и не показывает пользователю ни ошибок, ни отказов, — и
 * тащить его в тот же путь значило бы усложнять роутер ради случая, который устроен иначе.
 *
 * Отсюда же и обращение с отказами: любой сбой отвечает пустым списком. Молчаливое «нет
 * подсказок» здесь честнее исключения — имя всегда можно набрать руками, и команда его
 * проверит сама.
 */

/** Discord показывает не больше двадцати пяти подсказок. */
const LIMIT = 25;

export function createFormatAutocomplete(deps: {
  formats: FormatsService;
}): EventHandler<'interactionCreate'> {
  return {
    event: 'interactionCreate',
    async handle(ctx, interaction: Interaction): Promise<void> {
      if (!interaction.isAutocomplete()) return;
      if (interaction.commandName !== 'tournament') return;

      const focused = interaction.options.getFocused(true);
      if (focused.name !== 'preset') return;
      if (!interaction.guildId) {
        await interaction.respond([]).catch(() => {});
        return;
      }

      try {
        const typed = String(focused.value).trim().toLowerCase();
        const rows = await deps.formats.list(interaction.guildId);
        // Список уже отсортирован по числу запусков, поэтому фильтр порядок не ломает: сверху
        // остаётся то, чем правда пользуются, а не то, что назвали первым.
        const matching = rows
          .filter((row) => typed === '' || row.name.toLowerCase().includes(typed))
          .slice(0, LIMIT);

        await interaction.respond(matching.map((row) => ({ name: row.name, value: row.name })));
      } catch (error) {
        ctx.logger.warn({ err: error }, 'подсказки форматов не собрались');
        await interaction.respond([]).catch(() => {});
      }
    },
  };
}
