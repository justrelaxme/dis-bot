import { PermissionFlagsBits, SlashCommandBuilder, type Guild } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { TITLE_BONUS } from '../placements.js';
import { isOrganizer, type StaffDeps } from '../discord/staff.js';
import type { CircuitService, CircuitStanding } from '../services/circuit.js';

/**
 * `/season` — сезонная серия: таблица, начало и закрытие сезона.
 *
 * Таблицу смотрит кто угодно, а начинать и закрывать сезон — организатор. Права проверяются при
 * вызове, а не на уровне команды: `/season table` нужна всем.
 */

const TABLE_LIMIT = 15;

function tableLines(table: CircuitStanding[]): string[] {
  return table.slice(0, TABLE_LIMIT).map((row, index) => {
    const crowns = row.titles > 0 ? ` · 🏆×${row.titles}` : '';
    return `**${index + 1}.** <@${row.userId}> — **${row.points}** очк. · турниров ${row.tournaments}${crowns}`;
  });
}

export function createSeasonCommand(deps: { circuit: CircuitService; staff: StaffDeps; publicBaseUrl: string }): CommandDefinition {
  async function requireOrganizer(guild: Guild, member: Parameters<typeof isOrganizer>[0]): Promise<void> {
    const settings = await deps.staff.settings.get(guild.id).catch(() => null);
    if (!isOrganizer(member, settings)) {
      throw new UserError('Начинать и закрывать сезон может организатор: «Управление сервером» или роль из `/tournament settings`.');
    }
  }

  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('season')
      .setDescription('Сезонная серия: турниры складываются в одну таблицу')
      .addSubcommand((sub) => sub.setName('table').setDescription('Таблица текущего сезона'))
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Организатор: начать сезон — с этого момента турниры приносят очки')
          .addStringOption((option) =>
            option.setName('name').setDescription('Название, например «Осень 2026»').setRequired(true).setMaxLength(60),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('close')
          .setDescription('Организатор: закрыть сезон и назвать чемпиона')
          .addRoleOption((option) =>
            option.setName('crown').setDescription('Роль чемпиона: перейдёт к новому, у прежнего снимется'),
          ),
      ),

    async execute(interaction): Promise<void> {
      const guild = interaction.guild;
      if (!guild) throw new UserError('Эта команда работает только на сервере.');
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'table') {
        const season = await deps.circuit.open(guild.id);
        if (!season) {
          await interaction.editReply({
            content: 'Сезон сейчас не идёт. Организатор начинает его командой `/season start` — с этого момента каждый турнир приносит очки.',
          });
          return;
        }
        const table = await deps.circuit.standings(season.id, TABLE_LIMIT);
        await interaction.editReply({
          content: [
            `## Сезон «${season.name}»`,
            ...(table.length > 0 ? tableLines(table) : ['Пока ни одного доигранного турнира в этом сезоне.']),
            '',
            `Очки: по одному за каждого, кого оставил позади, одно за участие и ${TITLE_BONUS} сверху за титул. Таблица целиком: ${deps.publicBaseUrl}/season`,
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }

      await requireOrganizer(guild, interaction.member);

      if (subcommand === 'start') {
        const season = await deps.circuit.start(guild.id, interaction.options.getString('name', true));
        await interaction.editReply({
          content: [
            `## Сезон «${season.name}» начался`,
            `С этого момента каждый доигранный турнир приносит очки всем, кто в нём играл: по одному за каждого, кого оставил позади, одно за участие и ${TITLE_BONUS} сверху за титул.`,
            'Таблица — `/season table`. Закрыть сезон и назвать чемпиона — `/season close`.',
          ].join('\n'),
        });
        return;
      }

      const { season, table } = await deps.circuit.close(guild.id);
      const champion = table[0] ?? null;
      const crown = interaction.options.getRole('crown');
      const crownNote: string[] = [];
      if (crown && champion) {
        // Роль чемпиона — текущий статус: переходит к новому и снимается у прежнего. Запись в
        // зале славы при этом остаётся навсегда.
        try {
          const role = await guild.roles.fetch(crown.id);
          if (role) {
            for (const holder of role.members.values()) {
              if (holder.id !== champion.userId) await holder.roles.remove(role, 'Корона сезона перешла к новому чемпиону');
            }
            const member = await guild.members.fetch(champion.userId);
            await member.roles.add(role, `Чемпион сезона «${season.name}»`);
            crownNote.push(`Роль <@&${role.id}> — у чемпиона.`);
          }
        } catch {
          const canManage = guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false;
          crownNote.push(
            canManage
              ? '⚠️ Роль чемпиона выдать не вышло: роль бота стоит ниже неё — поднимите роль бота в настройках сервера.'
              : '⚠️ Роль чемпиона выдать не вышло: у бота нет права «Управление ролями».',
          );
        }
      }

      await interaction.editReply({
        content: [
          `## Сезон «${season.name}» закрыт`,
          champion ? `👑 Чемпион сезона — <@${champion.userId}>: **${champion.points}** очков за ${champion.tournaments} турн.` : 'В этом сезоне не было доигранных турниров — чемпиона нет.',
          ...(table.length > 1 ? ['', ...tableLines(table.slice(1, 5)).map((line, index) => line.replace(/^\*\*\d+\.\*\*/u, `**${index + 2}.**`))] : []),
          ...(crownNote.length > 0 ? ['', ...crownNote] : []),
          '',
          'Имя чемпиона уже в зале славы. Новый сезон — `/season start`.',
        ].join('\n'),
        allowedMentions: champion ? { users: [champion.userId] } : { parse: [] },
      });
    },
  };
}
