import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { isOrganizer, type StaffDeps } from '../discord/staff.js';
import type { TournamentsService } from '../services/tournaments.js';

/**
 * `/cast` — трансляция через Discord: адрес сцены для Go Live и личный пульт к ней.
 *
 * Сцена публичная: её показывают всем, и адрес не секрет. Пульт — личный: ссылка на него и
 * есть право переключать сцены, поэтому ответ эфемерный, как у всех ссылок-пропусков.
 *
 * Права — организатора, но не через «Управление сервером» на уровне команды: трансляцию часто
 * ведёт не администратор, а тот, кому доверили турниры, — роль организаторов из
 * `/tournament settings`.
 */
export function createCastCommand(deps: {
  tournaments: TournamentsService;
  staff: StaffDeps;
  grants: { issue(input: { guildId: string; userId: string; scope: 'cast' }): Promise<{ token: string; expiresAt: Date }> };
  publicBaseUrl: string;
}): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('cast')
      .setDescription('Трансляция турнира через Discord: сцена для демонстрации экрана и пульт к ней'),

    async execute(interaction): Promise<void> {
      const guild = interaction.guild;
      if (!guild) throw new UserError('Эта команда работает только на сервере.');
      const settings = await deps.staff.settings.get(guild.id).catch(() => null);
      if (!isOrganizer(interaction.member, settings)) {
        throw new UserError('Трансляцией управляет организатор: «Управление сервером» или роль из `/tournament settings`.');
      }

      const tournament = await deps.tournaments.onAir(guild.id);
      if (!tournament) throw new UserError('На сервере нет ни идущего, ни доигранного турнира — показывать нечего.');

      const grant = await deps.grants.issue({ guildId: guild.id, userId: interaction.user.id, scope: 'cast' });
      const overlay = `${deps.publicBaseUrl}/cast/t/${tournament.id}`;

      await interaction.followUp({
        content: [
          `## Трансляция «${tournament.name}»`,
          `**Сцена:** ${overlay}`,
          'Откройте её отдельным окном и покажите в голосовом канале: «Демонстрация экрана» → это окно. Сцена сама переключается — отсчёт, драфт, табло матча, сетка, пьедестал.',
          `Поверх игры через OBS: источник «Браузер» с адресом \`${overlay}?bg=transparent\`.`,
          '',
          `**Твой пульт:** ${deps.publicBaseUrl}/cast/control/${grant.token}`,
          `Ссылка личная и действует до <t:${Math.floor(grant.expiresAt.getTime() / 1_000)}:t> — кто откроет, тот и переключает сцены. Новая ссылка гасит эту.`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
