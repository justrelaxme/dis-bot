import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type Guild, type Role } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { TITLE_BONUS } from '../placements.js';
import { isOrganizer, type StaffDeps } from '../discord/staff.js';
import { sharedPlaces, type CircuitService, type CircuitStanding } from '../services/circuit.js';

/**
 * `/season` — сезонная серия: таблица, начало и закрытие сезона.
 *
 * Таблицу смотрит кто угодно, а начинать и закрывать сезон — организатор. Права проверяются при
 * вызове, а не на уровне команды: `/season table` нужна всем.
 */

const TABLE_LIMIT = 15;

function tableLines(table: CircuitStanding[]): string[] {
  const places = sharedPlaces(table);
  return table.slice(0, TABLE_LIMIT).map((row, index) => {
    const crowns = row.titles > 0 ? ` · 🏆×${row.titles}` : '';
    return `**${places[index]}.** <@${row.userId}> — **${row.points}** очк. · турниров ${row.tournaments}${crowns}`;
  });
}

/**
 * Можно ли сделать эту роль короной. Бот раздаёт и снимает её своими правами, поэтому
 * проверяется и вызвавший: команда не должна давать организатору больше, чем он может сам, —
 * иначе `/season close crown:@Модератор` снял бы модераторов и выдал роль лидеру таблицы.
 * Возвращает причину отказа или `null`.
 */
function crownRefusal(interaction: ChatInputCommandInteraction, guild: Guild, role: Role, callerTop: number): string | null {
  if (role.id === guild.id) return 'Роль @everyone короной быть не может.';
  if (role.managed) return `Роль ${role.name} принадлежит интеграции — выдавать её руками нельзя.`;
  if (interaction.user.id !== guild.ownerId) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      return 'Назначать роль-корону может тот, у кого есть право «Управление ролями».';
    }
    if (role.position >= callerTop) return `Роль ${role.name} не ниже твоей высшей роли — выдавать её ты не можешь, значит, и бот за тебя не станет.`;
  }
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 'У бота нет права «Управление ролями» — корону выдать нечем.';
  if (role.position >= me.roles.highest.position) {
    return `Роль ${role.name} стоит выше роли бота — поднимите роль бота в настройках сервера.`;
  }
  return null;
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
          )
          .addUserOption((option) =>
            option.setName('champion').setDescription('Только при ничьей на первом месте: кого из равных назвать чемпионом'),
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
          // Название сезона пишет организатор, и ответ публичный: «@everyone» в названии не
          // должен звать весь сервер.
          allowedMentions: { parse: [] },
        });
        return;
      }

      const crown = interaction.options.getRole('crown');
      const crownRole = crown ? await guild.roles.fetch(crown.id).catch(() => null) : null;
      if (crown) {
        // Проверка до закрытия: отказ по роли не должен оставлять сезон закрытым без короны.
        const caller = await guild.members.fetch(interaction.user.id).catch(() => null);
        const refusal = crownRole
          ? crownRefusal(interaction, guild, crownRole, caller?.roles.highest.position ?? 0)
          : 'Такой роли на сервере нет.';
        if (refusal) throw new UserError(refusal);
      }

      // Имена из Discord для тех, у кого их в таблице нет: чемпион уходит в зал славы по имени.
      const open = await deps.circuit.open(guild.id);
      const names = new Map<string, string>();
      if (open) {
        const missing = (await deps.circuit.standings(open.id, 50)).filter((row) => row.name === null).map((row) => row.userId);
        if (missing.length > 0) {
          const found = await guild.members.fetch({ user: missing }).catch(() => null);
          for (const member of found?.values() ?? []) names.set(member.id, member.displayName);
        }
      }

      const pick = interaction.options.getUser('champion')?.id;
      const { season, table } = await deps.circuit.close(guild.id, { names, ...(pick ? { pick } : {}) });
      const champion = table[0] ?? null;
      const crownNote: string[] = [];
      if (crownRole && champion) {
        // Роль чемпиона — текущий статус: переходит к новому и снимается у прежнего. Запись в
        // зале славы при этом остаётся навсегда. Список держателей берётся после полной
        // загрузки участников: в кэше есть не все, и прежний чемпион мог остаться с короной.
        await guild.members.fetch().catch(() => undefined);
        const failures: string[] = [];
        for (const holder of crownRole.members.values()) {
          if (holder.id === champion.userId) continue;
          await holder.roles.remove(crownRole, 'Корона сезона перешла к новому чемпиону').catch(() => failures.push(`<@${holder.id}>`));
        }
        const member = await guild.members.fetch(champion.userId).catch(() => null);
        if (!member) {
          crownNote.push(`⚠️ Роль <@&${crownRole.id}> не выдана: чемпиона больше нет на сервере.`);
        } else {
          const given = await member.roles.add(crownRole, `Чемпион сезона «${season.name}»`).then(() => true, () => false);
          crownNote.push(given ? `Роль <@&${crownRole.id}> — у чемпиона.` : `⚠️ Роль <@&${crownRole.id}> выдать не вышло — проверьте права бота.`);
        }
        if (failures.length > 0) crownNote.push(`⚠️ Не снялась роль у: ${failures.join(', ')}.`);
      }

      await interaction.editReply({
        content: [
          `## Сезон «${season.name}» закрыт`,
          champion ? `👑 Чемпион сезона — <@${champion.userId}>: **${champion.points}** очков за ${champion.tournaments} турн.` : 'В этом сезоне не было доигранных турниров — чемпиона нет.',
          ...(table.length > 1 ? ['', ...tableLines(table).slice(1, 5)] : []),
          ...(crownNote.length > 0 ? ['', ...crownNote] : []),
          '',
          'Имя чемпиона уже в зале славы. Новый сезон — `/season start`.',
        ].join('\n'),
        allowedMentions: champion ? { users: [champion.userId] } : { parse: [] },
      });
    },
  };
}
