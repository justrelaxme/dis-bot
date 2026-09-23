import type { Interaction } from 'discord.js';
import type { EventHandler } from '../../../core/module.js';
import type { MatchState } from '../schema.js';
import type { FormatsService } from '../services/formats.js';
import type { TournamentsService } from '../services/tournaments.js';

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

/** Какие матчи предлагать какой подкоманде. */
const PICKER_STATES: Record<string, readonly MatchState[]> = {
  resolve: ['ready', 'reported', 'disputed'],
  walkover: ['ready', 'reported', 'disputed'],
  correct: ['confirmed', 'walkover'],
};

const STATE_NOTE: Partial<Record<MatchState, string>> = {
  ready: 'идёт',
  reported: 'ждёт подтверждения',
  disputed: 'спор',
  confirmed: 'закрыт',
  walkover: 'без игры',
};

/**
 * Подсказки номера матча и победителя в `/match resolve | walkover | correct`. Раньше номер
 * матча надо было искать на сайте, а имя победителя вписывать буква в букву — и опечатка
 * отвечала «нет такого участника» посреди спора.
 */
export function createMatchAutocomplete(deps: {
  tournaments: Pick<TournamentsService, 'current' | 'matchesForPicker' | 'bracket' | 'matchById'>;
}): EventHandler<'interactionCreate'> {
  return {
    event: 'interactionCreate',
    async handle(ctx, interaction: Interaction): Promise<void> {
      if (!interaction.isAutocomplete() || interaction.commandName !== 'match') return;
      const focused = interaction.options.getFocused(true);
      if (focused.name !== 'match' && focused.name !== 'winner') return;

      try {
        const tournament = interaction.guildId ? await deps.tournaments.current(interaction.guildId) : null;
        if (!tournament) {
          await interaction.respond([]);
          return;
        }
        const view = await deps.tournaments.bracket(tournament.id);
        const nameOf = (id: number | null): string => view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';

        if (focused.name === 'match') {
          const states = PICKER_STATES[interaction.options.getSubcommand()] ?? PICKER_STATES['resolve']!;
          const typed = String(focused.value).trim().toLowerCase();
          const rows = (await deps.tournaments.matchesForPicker(tournament.id, states))
            .map((match) => ({
              match,
              label: `№${match.id} · ${nameOf(match.entrantAId)} — ${nameOf(match.entrantBId)} · ${STATE_NOTE[match.state] ?? match.state}`,
            }))
            .filter(({ match, label }) => typed === '' || String(match.id).startsWith(typed) || label.toLowerCase().includes(typed))
            // Спорные и ждущие подтверждения — наверх: ради них команду обычно и набирают.
            .sort((x, y) => Number(y.match.state === 'disputed') - Number(x.match.state === 'disputed') || x.match.id - y.match.id)
            .slice(0, LIMIT);
          await interaction.respond(rows.map(({ match, label }) => ({ name: label.slice(0, 100), value: match.id })));
          return;
        }

        // Победитель — один из двух соперников выбранного матча, и больше никто.
        const matchId = interaction.options.getInteger('match');
        const match = matchId ? await deps.tournaments.matchById(matchId).catch(() => null) : null;
        const sides = match ? [match.entrantAId, match.entrantBId] : view.entrants.map((entrant) => entrant.id);
        const names = sides.filter((id): id is number => id !== null).map(nameOf);
        const typed = String(focused.value).trim().toLowerCase();
        await interaction.respond(
          names
            .filter((name) => typed === '' || name.toLowerCase().includes(typed))
            .slice(0, LIMIT)
            .map((name) => ({ name, value: name })),
        );
      } catch (error) {
        ctx.logger.warn({ err: error }, 'подсказки матчей не собрались');
        await interaction.respond([]).catch(() => {});
      }
    },
  };
}
