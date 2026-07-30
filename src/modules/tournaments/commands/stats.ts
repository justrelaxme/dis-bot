import { SlashCommandBuilder } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { plural } from '../../../core/russian.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import { playerRecord, titlesByTeam } from '../services/records.js';

export interface StatsDeps {
  db: Database;
  publicBaseUrl: string;
}

const day = (date: Date | null): string =>
  date === null ? 'дата неизвестна' : `<t:${Math.floor(date.getTime() / 1_000)}:d>`;

/**
 * Турнирный след человека. Публично, а не втайне: это то, чем хвастаются, и показывать
 * такое одному себе бессмысленно.
 *
 * Личная статистика живёт в Discord, а не на витрине, и это не случайность. Витрина
 * показывает командные результаты — события сервера, которые и так публичны. Кто именно
 * стоял в составе, публиковать без согласия человека нельзя, поэтому персональные цифры
 * отдаются только в Discord, где спрашивающий уже участник сервера.
 */
export function createStatsCommand(deps: StatsDeps): CommandDefinition {
  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Турнирный след: титулы, матчи, последние турниры')
      .addUserOption((option) =>
        option.setName('user').setDescription('Чей след посмотреть, по умолчанию свой'),
      ),

    async execute(interaction): Promise<void> {
      if (!interaction.guildId) throw new UserError('Эта команда работает только на сервере.');

      const target = interaction.options.getUser('user') ?? interaction.user;
      const record = await playerRecord(deps.db, interaction.guildId, target.id);
      const mine = target.id === interaction.user.id;

      if (record.tournaments === 0) {
        await interaction.editReply({
          content: mine
            ? [
                'Завершённых турниров пока нет — след начинается с первого.',
                'Как попасть: кнопка **«Что мне делать?»** под объявлением турнира разберёт твой случай и назовёт один следующий шаг.',
              ].join('\n')
            : `У <@${target.id}> ещё нет завершённых турниров.`,
        });
        return;
      }

      const rate =
        record.matchesPlayed === 0
          ? null
          : Math.round((record.matchesWon / record.matchesPlayed) * 100);

      const titleLine =
        record.titles === 0
          ? 'Титулов пока нет'
          : `**${record.titles}** ${plural(record.titles, 'титул', 'титула', 'титулов')}`;

      const history = record.recent.map((entry) => {
        const game = TOURNAMENT_GAME_LABELS[entry.game] ?? entry.game;
        const wins =
          entry.matchesWon === 0
            ? 'без побед'
            : `${entry.matchesWon} ${plural(entry.matchesWon, 'победа', 'победы', 'побед')}`;
        return `${entry.champion ? '🏆' : '•'} ${game} — «${entry.teamName}», ${wins} · ${day(entry.finishedAt)}`;
      });

      const top = await titlesByTeam(deps.db, interaction.guildId, 3);
      const leaders = top
        .map(
          (team, index) =>
            `${index + 1}. **${team.name}** — ${team.titles} ${plural(team.titles, 'титул', 'титула', 'титулов')}`,
        )
        .join('\n');

      await interaction.editReply({
        content: [
          `## Турнирный след — ${target.displayName}`,
          `${titleLine} · турниров: **${record.tournaments}** · матчей сыграно: **${record.matchesPlayed}**${
            rate === null ? '' : `, выиграно **${record.matchesWon}** (${rate}%)`
          }`,
          '',
          '**Последние турниры**',
          ...history,
          ...(leaders ? ['', '**Больше всех титулов на сервере** (по названию команды)', leaders] : []),
          '',
          `Все турниры сервера: ${deps.publicBaseUrl}/hall`,
        ].join('\n'),
      });
    },
  };
}
