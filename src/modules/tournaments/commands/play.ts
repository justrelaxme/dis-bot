import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Guild,
  type Interaction,
} from 'discord.js';
import { UserError, describeForUser } from '../../../core/errors.js';
import type { CommandDefinition, EventHandler, ModuleContext } from '../../../core/module.js';
import type { ChannelsGateway } from '../discord/channels.js';
import type { TournamentsService } from '../services/tournaments.js';

/**
 * Идентификаторы кнопок. Короткие намеренно: Discord ограничивает custom_id сотней
 * символов, а формат «префикс:число» разбирается однозначно и не ломается от имён команд.
 */
const BTN_JOIN = 'tj';
const BTN_CONFIRM = 'mc';
const BTN_DISPUTE = 'md';

export interface PlayDeps {
  tournaments: TournamentsService;
  channels: ChannelsGateway;
  publicBaseUrl: string;
}

function requireGuild(guild: Guild | null): Guild {
  if (!guild) throw new UserError('Эта команда работает только на сервере.');
  return guild;
}

async function currentTournament(deps: PlayDeps, guild: Guild) {
  const tournament = await deps.tournaments.current(guild.id);
  if (!tournament) throw new UserError('Сейчас на сервере нет турнира.');
  return tournament;
}

/** Карточка команды с кнопкой: состав добирается сам, капитану не надо звать по одному. */
function teamCard(entrantId: number, teamName: string, have: number, need: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BTN_JOIN}:${entrantId}`)
      .setLabel(have >= need ? `${teamName}: состав собран` : `Вступить в «${teamName}» (${have}/${need})`)
      .setStyle(have >= need ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(have >= need),
  );
}

export function createTeamCommand(deps: PlayDeps): CommandDefinition {
  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('team')
      .setDescription('Команда для турнира')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Создать команду и вывесить карточку с кнопкой «Вступить»')
          .addStringOption((option) =>
            option.setName('name').setDescription('Название команды').setRequired(true).setMaxLength(60),
          ),
      )
      .addSubcommand((sub) => sub.setName('leave').setDescription('Выйти из команды'))
      .addSubcommand((sub) => sub.setName('roster').setDescription('Кто в составе')),

    async execute(interaction): Promise<void> {
      const guild = requireGuild(interaction.guild);
      const tournament = await currentTournament(deps, guild);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'create') {
        const name = interaction.options.getString('name', true);
        const entrant = await deps.tournaments.createEntrant(tournament.id, interaction.user.id, name);

        if (tournament.entryMode === 'solo') {
          await interaction.editReply({
            content: `<@${interaction.user.id}> записан(а) в турнир как **${entrant.displayName}**. Перед стартом отметься: \`/checkin\`.`,
          });
          return;
        }

        await interaction.editReply({
          content: `**${entrant.displayName}** собирает состав на «${tournament.name}». Нужно ${tournament.teamSize} человек — жмите кнопку.`,
          components: [teamCard(entrant.id, entrant.displayName, 1, tournament.teamSize)],
        });
        return;
      }

      if (subcommand === 'leave') {
        await deps.tournaments.leaveEntrant(tournament.id, interaction.user.id);
        await interaction.editReply({ content: `<@${interaction.user.id}> вышел(ла) из состава.` });
        return;
      }

      if (subcommand === 'roster') {
        const entrant = await deps.tournaments.entrantOfUser(tournament.id, interaction.user.id);
        if (!entrant) throw new UserError('Ты пока не участвуешь. Собрать команду: `/team create`.');
        const members = await deps.tournaments.membersOf(entrant.id);
        await interaction.editReply({
          content: [
            `**${entrant.displayName}** — ${members.length} из ${tournament.teamSize}`,
            members.map((id) => `• <@${id}>${id === entrant.captainUserId ? ' (капитан)' : ''}`).join('\n'),
            entrant.checkedInAt ? 'Состав отмечен.' : 'Капитану надо отметить состав: `/checkin`.',
          ].join('\n'),
        });
        return;
      }

      throw new UserError('Неизвестная подкоманда.');
    },
  };
}

export function createCheckinCommand(deps: PlayDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('checkin')
      .setDescription('Отметить состав перед стартом — без этого в сетку не попадёте'),

    async execute(interaction): Promise<void> {
      const guild = requireGuild(interaction.guild);
      const tournament = await currentTournament(deps, guild);
      const entrant = await deps.tournaments.checkIn(tournament.id, interaction.user.id);
      await interaction.editReply({
        content: `**${entrant.displayName}** отмечен(а). Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
      });
    },
  };
}

/** Кнопки подтверждения результата: соперник жмёт, а не набирает команду. */
function matchButtons(matchId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${BTN_CONFIRM}:${matchId}`).setLabel('Подтвердить').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${BTN_DISPUTE}:${matchId}`).setLabel('Не так было').setStyle(ButtonStyle.Danger),
  );
}

export function createMatchCommand(deps: PlayDeps): CommandDefinition {
  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('match')
      .setDescription('Результаты матчей')
      .addSubcommand((sub) =>
        sub
          .setName('report')
          .setDescription('Заявить результат своего матча')
          .addStringOption((option) =>
            option
              .setName('outcome')
              .setDescription('Чем закончилось')
              .setRequired(true)
              .addChoices({ name: 'Мы выиграли', value: 'win' }, { name: 'Мы проиграли', value: 'loss' }),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('resolve')
          .setDescription('Организатор: решить спорный матч')
          .addIntegerOption((option) => option.setName('match').setDescription('Номер матча').setRequired(true))
          .addStringOption((option) =>
            option.setName('winner').setDescription('Название победителя').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('walkover')
          .setDescription('Организатор: победа без игры при неявке')
          .addIntegerOption((option) => option.setName('match').setDescription('Номер матча').setRequired(true))
          .addStringOption((option) =>
            option.setName('winner').setDescription('Название явившегося').setRequired(true),
          ),
      ),

    async execute(interaction, ctx): Promise<void> {
      const guild = requireGuild(interaction.guild);
      const tournament = await currentTournament(deps, guild);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'report') {
        const match = await deps.tournaments.currentMatchOf(tournament.id, interaction.user.id);
        if (!match) throw new UserError('У тебя нет матча, который сейчас можно отметить.');

        const mine = await deps.tournaments.entrantOfUser(tournament.id, interaction.user.id);
        if (!mine) throw new UserError('Ты не участвуешь в этом турнире.');

        const opponentId = match.entrantAId === mine.id ? match.entrantBId : match.entrantAId;
        if (opponentId === null) throw new UserError('В этом матче ещё не известен соперник.');

        const won = interaction.options.getString('outcome', true) === 'win';
        const winnerId = won ? mine.id : opponentId;
        await deps.tournaments.report(match.id, interaction.user.id, winnerId);

        const view = await deps.tournaments.bracket(tournament.id);
        const winnerName = view.entrants.find((entrant) => entrant.id === winnerId)?.displayName ?? '?';
        const opponentMembers = await deps.tournaments.membersOf(opponentId);

        await interaction.editReply({
          content: [
            `Матч №${match.id}: заявлена победа **${winnerName}**.`,
            `${opponentMembers.map((id) => `<@${id}>`).join(' ')} — подтвердите или оспорьте.`,
            'Если не ответить час, результат примется сам.',
          ].join('\n'),
          components: [matchButtons(match.id)],
        });
        return;
      }

      // Организаторские подкоманды: проверяем право здесь, а не на уровне команды —
      // иначе /match report тоже стал бы админским.
      const member = interaction.member;
      const canManage =
        member !== null && 'permissions' in member && typeof member.permissions !== 'string'
          ? member.permissions.has(PermissionFlagsBits.ManageGuild)
          : false;
      if (!canManage) throw new UserError('Это может только организатор турнира.');

      const matchId = interaction.options.getInteger('match', true);
      const winnerName = interaction.options.getString('winner', true).trim().toLowerCase();
      const view = await deps.tournaments.bracket(tournament.id);
      const winner = view.entrants.find((entrant) => entrant.displayName.toLowerCase() === winnerName);
      if (!winner) throw new UserError(`В турнире нет участника «${winnerName}».`);

      const result =
        subcommand === 'resolve'
          ? await deps.tournaments.resolve(matchId, interaction.user.id, winner.id)
          : await deps.tournaments.walkover(matchId, interaction.user.id, winner.id);

      await interaction.editReply({
        content: `Матч №${matchId}: победа **${winner.displayName}**${subcommand === 'walkover' ? ' без игры' : ''}.${result.finished ? `\n\n🏆 Турнир завершён. Победитель — **${winner.displayName}**.` : ''}`,
      });

      if (result.finished) await cleanup(deps, guild, tournament.id, ctx);
      else await ensureMatchThreads(deps, guild, tournament.id);
    },
  };
}

/**
 * Создаёт комнаты матчам, которым они нужны. Вызывается после каждого изменения сетки:
 * выборка идёт по отсутствию ветки, поэтому повторный вызов добирает то, что не удалось
 * создать в прошлый раз, и ничего не дублирует.
 *
 * Каналы команд приватные, значит без этой комнаты соперники друг с другом не свяжутся —
 * а им надо договориться о лобби, пароле и времени.
 */
export async function ensureMatchThreads(deps: PlayDeps, guild: Guild, tournamentId: number): Promise<void> {
  const tournament = await deps.tournaments.byId(tournamentId);
  if (!tournament.matchParentId) return;

  const pending = await deps.tournaments.matchesNeedingThread(tournamentId);
  if (pending.length === 0) return;

  const view = await deps.tournaments.bracket(tournamentId);
  const nameOf = (id: number | null): string =>
    view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';

  for (const match of pending) {
    const [a, b] = await Promise.all([
      deps.tournaments.membersOf(match.entrantAId ?? 0),
      deps.tournaments.membersOf(match.entrantBId ?? 0),
    ]);

    const threadId = await deps.channels.createMatchThread({
      guild,
      parentId: tournament.matchParentId,
      title: `Матч ${match.id}: ${nameOf(match.entrantAId)} — ${nameOf(match.entrantBId)}`,
      memberIds: [...a, ...b],
    });
    if (threadId) await deps.tournaments.attachThread(match.id, threadId);
  }
}

/**
 * Все комнаты турнира: голосовые командам и ветки матчам. Одна функция на оба пути старта
 * — по команде организатора и по расписанию, — иначе автоматический турнир однажды
 * окажется без комнат, потому что их создание дописали только в одном месте.
 */
export async function createTournamentRooms(deps: PlayDeps, guild: Guild, tournamentId: number): Promise<void> {
  const tournament = await deps.tournaments.byId(tournamentId);
  const entrants = await deps.tournaments.activeEntrants(tournamentId);

  for (const entrant of entrants.filter((row) => row.seed !== null && row.voiceChannelId === null)) {
    const members = await deps.tournaments.membersOf(entrant.id);
    const channelId = await deps.channels.createTeamVoice({
      guild,
      categoryId: tournament.teamCategoryId,
      tournamentName: tournament.name,
      entrantId: entrant.id,
      teamName: entrant.displayName,
      memberIds: members,
    });
    if (channelId) await deps.tournaments.attachVoice(entrant.id, channelId);
  }

  await ensureMatchThreads(deps, guild, tournamentId);
}

/** Уборка комнат после турнира: без неё сервер за месяц ежедневных турниров забьётся. */
async function cleanup(deps: PlayDeps, guild: Guild, tournamentId: number, ctx: ModuleContext): Promise<void> {
  const entrants = await deps.tournaments.activeEntrants(tournamentId);
  for (const entrant of entrants) {
    if (entrant.voiceChannelId) await deps.channels.deleteChannel(guild, entrant.voiceChannelId);
  }

  // Ветки не удаляем, а архивируем: в них осталась переписка о матче, и она может
  // понадобиться, если кто-то придёт спорить об уже закрытом результате.
  for (const threadId of await deps.tournaments.closedThreads(tournamentId)) {
    await deps.channels.archiveThread(guild, threadId);
  }

  ctx.logger.info({ tournamentId }, 'комнаты турнира убраны');
}

/**
 * Кнопки. Роутер ядра обслуживает только slash-команды, поэтому модуль слушает
 * `interactionCreate` сам и разбирает свои кнопки по префиксу custom_id.
 */
export function createButtonHandler(deps: PlayDeps): EventHandler<'interactionCreate'> {
  return {
    event: 'interactionCreate',
    async handle(ctx, interaction: Interaction): Promise<void> {
      if (!interaction.isButton()) return;
      const [prefix, rawId] = interaction.customId.split(':');
      if (prefix !== BTN_JOIN && prefix !== BTN_CONFIRM && prefix !== BTN_DISPUTE) return;

      const id = Number.parseInt(rawId ?? '', 10);
      if (!Number.isInteger(id)) return;

      try {
        await handleButton(deps, interaction, prefix, id, ctx);
      } catch (error) {
        const described = describeForUser(error);
        if (described.incidentId) {
          ctx.logger.error({ err: error, incidentId: described.incidentId }, 'кнопка турнира упала');
        }
        const payload = { content: described.text, flags: MessageFlags.Ephemeral } as const;
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    },
  };
}

async function handleButton(
  deps: PlayDeps,
  interaction: ButtonInteraction,
  prefix: string,
  id: number,
  ctx: ModuleContext,
): Promise<void> {
  const guild = requireGuild(interaction.guild);
  const tournament = await currentTournament(deps, guild);

  if (prefix === BTN_JOIN) {
    const entrant = await deps.tournaments.joinEntrant(id, interaction.user.id);
    const members = await deps.tournaments.membersOf(entrant.id);

    // Карточку обновляем на месте: счётчик состава должен быть виден всем, кто ещё думает.
    await interaction.update({
      components: [teamCard(entrant.id, entrant.displayName, members.length, tournament.teamSize)],
    });
    await interaction.followUp({
      content: `<@${interaction.user.id}> в составе **${entrant.displayName}** (${members.length}/${tournament.teamSize}).`,
    });
    return;
  }

  if (prefix === BTN_CONFIRM) {
    const { match, finished } = await deps.tournaments.confirm(id, interaction.user.id);
    const view = await deps.tournaments.bracket(tournament.id);
    const winner = view.entrants.find((entrant) => entrant.id === match.winnerEntrantId);
    await interaction.update({ components: [] });
    await interaction.followUp({
      content: `Матч №${match.id} подтверждён: победа **${winner?.displayName ?? '?'}**.${finished ? `\n\n🏆 Турнир завершён. Победитель — **${winner?.displayName ?? '?'}**.` : ''}`,
    });

    // Победитель продвинулся — у следующего матча появились оба соперника, значит ему
    // нужна комната. А если это был последний матч, комнаты пора убирать: раньше этот
    // путь уборку не запускал, и после турнира, закрытого кнопкой, каналы оставались.
    if (finished) await cleanup(deps, guild, tournament.id, ctx);
    else await ensureMatchThreads(deps, guild, tournament.id);
    return;
  }

  const match = await deps.tournaments.dispute(id, interaction.user.id);
  await interaction.update({ components: [] });
  await interaction.followUp({
    content: `Матч №${match.id} оспорен. Организатор разберёт: \`/match resolve match:${match.id} winner:<название>\`.`,
  });
}
