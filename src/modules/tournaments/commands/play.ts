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
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { UserError, describeForUser } from '../../../core/errors.js';
import type { CommandDefinition, EventHandler, ModuleContext } from '../../../core/module.js';
import type { ChannelsGateway } from '../discord/channels.js';
import {
  BTN_CHECKIN,
  BTN_PANEL_CREATE,
  BTN_PANEL_FIND,
  BTN_PANEL_HELP,
  BTN_PANEL_SOLO,
  MODAL_TEAM_NAME,
  SELECT_TEAM_JOIN,
  nextStepText,
  rosterFullNudge,
  teamNameModal,
  teamPicker,
} from '../discord/onboarding.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import { hasVerifiedLink, linkCommandFor } from '../services/strength.js';
import type { DotaVerifier } from '../services/dota-verify.js';
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
  /**
   * Проверка результата по данным Dota. Необязательна: без ключей и без сети турнир
   * должен идти обычным путём, а не отказывать в приёме результата.
   */
  dotaVerifier?: DotaVerifier;
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
      .addSubcommand((sub) => sub.setName('roster').setDescription('Кто в составе'))
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Капитану: добавить игрока в состав — в том числе замену во время турнира')
          .addUserOption((option) =>
            option.setName('user').setDescription('Кого добавить').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('kick')
          .setDescription('Капитану: убрать игрока из состава')
          .addUserOption((option) =>
            option.setName('user').setDescription('Кого убрать').setRequired(true),
          ),
      ),

    async execute(interaction, ctx): Promise<void> {
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

      if (subcommand === 'add' || subcommand === 'kick') {
        const target = interaction.options.getUser('user', true);
        if (target.bot) throw new UserError('Бота в состав не записать.');

        const change =
          subcommand === 'add'
            ? await deps.tournaments.addMember(tournament.id, interaction.user.id, target.id)
            : await deps.tournaments.removeMember(tournament.id, interaction.user.id, target.id);

        // Комната команды закрывалась по списку, который был на старте. Пришедшего надо
        // пустить, ушедшего — вывести, иначе замена работает только в базе.
        if (change.entrant.voiceChannelId) {
          await deps.channels.setTeamVoiceAccess({
            guild,
            channelId: change.entrant.voiceChannelId,
            userId: target.id,
            allowed: subcommand === 'add',
          });
        }

        const tail = change.duringTournament
          ? ' Турнир идёт — замена уже в силе, комната команды переоткрыта.'
          : change.rosterSize >= tournament.teamSize
            ? ' Состав полный, можно отмечаться: `/checkin`.'
            : ` Осталось добрать ${tournament.teamSize - change.rosterSize}.`;

        // Про отсутствующую привязку говорим сразу, а не молчим до жеребьёвки: без неё
        // игрок считается нулевой силой, и состав окажется сеян ниже, чем есть на самом деле.
        const unlinked =
          subcommand === 'add' &&
          tournament.requireVerified &&
          !(await hasVerifiedLink(ctx.db, target.id, tournament.game))
            ? `\n\nУ <@${target.id}> нет подтверждённой привязки к ${TOURNAMENT_GAME_LABELS[tournament.game]} — играть это не мешает, но в жеребьёвке он считается без ранга. Привязать: \`${linkCommandFor(tournament.game)}\`.`
            : '';

        await interaction.editReply({
          content:
            (subcommand === 'add'
              ? `<@${target.id}> в составе **${change.entrant.displayName}** — ${change.rosterSize} из ${tournament.teamSize}.${tail}`
              : `<@${target.id}> убран(а) из **${change.entrant.displayName}** — ${change.rosterSize} из ${tournament.teamSize}.${tail}`) +
            unlinked,
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

    async execute(interaction, ctx): Promise<void> {
      const guild = requireGuild(interaction.guild);
      const tournament = await currentTournament(deps, guild);
      const entrant = await deps.tournaments.checkIn(tournament.id, interaction.user.id);
      const members = await deps.tournaments.membersOf(entrant.id);

      // Отметка не блокируется отсутствием привязок — иначе на сервере, где ещё никто не
      // привязался, первый турнир не состоялся бы вообще. Но сказать об этом надо здесь:
      // дальше жеребьёвка, и без ранга человек уйдёт в неё нулевой силой.
      const unlinked = tournament.requireVerified
        ? (
            await Promise.all(
              members.map(async (userId) =>
                (await hasVerifiedLink(ctx.db, userId, tournament.game)) ? null : userId,
              ),
            )
          ).filter((userId): userId is string => userId !== null)
        : [];

      const short = members.length < tournament.teamSize;

      await interaction.editReply({
        content: [
          `**${entrant.displayName}** отмечен(а) — ${members.length} из ${tournament.teamSize} в составе.`,
          short
            ? 'Состав неполный — в сетку попадёте, но играть придётся меньшим числом. Добрать: кнопкой под объявлением или `/team add`.'
            : null,
          unlinked.length > 0
            ? `Без подтверждённой привязки к ${TOURNAMENT_GAME_LABELS[tournament.game]}: ${unlinked.map((id) => `<@${id}>`).join(', ')}. В жеребьёвке они считаются без ранга — \`${linkCommandFor(tournament.game)}\`.`
            : null,
          `Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
        ]
          .filter((line) => line !== null)
          .join('\n'),
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
          )
          .addStringOption((option) =>
            option
              .setName('dota_match')
              .setDescription('ID матча Dota — бот проверит сам, и подтверждение соперника не понадобится')
              .setMaxLength(12),
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

        const view = await deps.tournaments.bracket(tournament.id);
        const nameOf = (id: number): string =>
          view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';

        // Проверка по данным игры, если ID матча дали. Она необязательна и часто
        // невозможна — Dota по умолчанию не показывает игроков публичных матчей, — поэтому
        // любой её отрицательный исход, кроме прямого противоречия, ведёт на обычный путь.
        const dotaMatchId = interaction.options.getString('dota_match');
        if (dotaMatchId && deps.dotaVerifier && tournament.game === 'dota2') {
          const verdict = await deps.dotaVerifier.verify({
            dotaMatchId,
            entrantAId: mine.id,
            entrantBId: opponentId,
            notBefore: tournament.startedAt,
          });

          if (verdict.kind === 'decided' && verdict.winnerEntrantId !== winnerId) {
            throw new UserError(
              [
                `По данным матча \`${dotaMatchId}\` победила **${nameOf(verdict.winnerEntrantId)}**, а не то, что заявлено.`,
                'Заявку не принял. Если ID матча указан неверно — повтори с правильным, а если данные врут, зови организатора: `/match resolve` решит спор.',
              ].join('\n'),
            );
          }

          if (verdict.kind === 'decided') {
            const settled = await deps.tournaments.settle(
              match.id,
              winnerId,
              interaction.user.id,
              'verified',
              false,
            );
            await interaction.editReply({
              content: [
                `Матч №${match.id}: победа **${nameOf(winnerId)}** — подтверждено данными матча \`${dotaMatchId}\`.`,
                `Соперника ждать не надо: узнал ${verdict.identifiedA + verdict.identifiedB} игроков по разные стороны.`,
                settled.finished
                  ? `\n🏆 Турнир завершён. Победитель — **${nameOf(winnerId)}**.`
                  : `Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
              ].join('\n'),
            });
            return;
          }

          // Проверить не вышло — говорим почему и идём обычным путём, не отказывая.
          await deps.tournaments.report(match.id, interaction.user.id, winnerId);
          const opponentMembers = await deps.tournaments.membersOf(opponentId);
          await interaction.editReply({
            content: [
              `Матч №${match.id}: заявлена победа **${nameOf(winnerId)}**.`,
              `Проверить по матчу \`${dotaMatchId}\` не получилось: ${verdict.reason}`,
              `${opponentMembers.map((id) => `<@${id}>`).join(' ')} — подтвердите или оспорьте.`,
              'Если не ответить час, результат примется сам.',
            ].join('\n'),
            components: [matchButtons(match.id)],
          });
          return;
        }

        await deps.tournaments.report(match.id, interaction.user.id, winnerId);
        const opponentMembers = await deps.tournaments.membersOf(opponentId);

        await interaction.editReply({
          content: [
            `Матч №${match.id}: заявлена победа **${nameOf(winnerId)}**.`,
            `${opponentMembers.map((id) => `<@${id}>`).join(' ')} — подтвердите или оспорьте.`,
            'Если не ответить час, результат примется сам.',
            ...(tournament.game === 'dota2' && deps.dotaVerifier
              ? ['', 'В следующий раз можно указать `dota_match:<ID матча>` — тогда бот проверит сам, и ждать соперника не придётся.']
              : []),
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
  const MATCH_PREFIXES = [BTN_JOIN, BTN_CONFIRM, BTN_DISPUTE];
  const PANEL_IDS = [BTN_PANEL_CREATE, BTN_PANEL_FIND, BTN_PANEL_HELP, BTN_PANEL_SOLO, BTN_CHECKIN];

  return {
    event: 'interactionCreate',
    async handle(ctx, interaction: Interaction): Promise<void> {
      const isOurs =
        (interaction.isButton() &&
          (PANEL_IDS.includes(interaction.customId) ||
            MATCH_PREFIXES.includes(interaction.customId.split(':')[0] ?? ''))) ||
        (interaction.isModalSubmit() && interaction.customId === MODAL_TEAM_NAME) ||
        (interaction.isStringSelectMenu() && interaction.customId === SELECT_TEAM_JOIN);
      if (!isOurs) return;

      try {
        if (interaction.isModalSubmit()) {
          await handleTeamNameModal(deps, interaction);
          return;
        }
        if (interaction.isStringSelectMenu()) {
          await handleTeamPick(deps, interaction);
          return;
        }
        if (!interaction.isButton()) return;

        if (PANEL_IDS.includes(interaction.customId)) {
          await handlePanel(deps, interaction, ctx);
          return;
        }

        const [prefix, rawId] = interaction.customId.split(':');
        const id = Number.parseInt(rawId ?? '', 10);
        if (!Number.isInteger(id) || prefix === undefined) return;
        await handleButton(deps, interaction, prefix, id, ctx);
      } catch (error) {
        const described = describeForUser(error);
        if (described.incidentId) {
          ctx.logger.error({ err: error, incidentId: described.incidentId }, 'взаимодействие турнира упало');
        }
        const payload = { content: described.text, flags: MessageFlags.Ephemeral } as const;
        // update() уже мог закрыть взаимодействие — тогда добавляем сообщение, а не отвечаем.
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
          else await interaction.reply(payload);
        }
      }
    },
  };
}

/** Панель регистрации: всё, что нужно новичку, здесь и кнопками. */
async function handlePanel(deps: PlayDeps, interaction: ButtonInteraction, ctx: ModuleContext): Promise<void> {
  const guild = requireGuild(interaction.guild);
  const tournament = await currentTournament(deps, guild);
  const userId = interaction.user.id;

  if (interaction.customId === BTN_PANEL_CREATE) {
    // Модальное окно нельзя показать после defer — отвечаем им сразу.
    await interaction.showModal(teamNameModal());
    return;
  }

  if (interaction.customId === BTN_PANEL_SOLO) {
    const entrant = await deps.tournaments.createEntrant(tournament.id, userId, interaction.user.displayName);
    await interaction.reply({
      content: `Записал: **${entrant.displayName}**. Перед стартом нажми **Я готов**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === BTN_CHECKIN) {
    const entrant = await deps.tournaments.checkIn(tournament.id, userId);
    await interaction.reply({
      content: `**${entrant.displayName}** отмечена и попадёт в сетку.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === BTN_PANEL_FIND) {
    const teams = await deps.tournaments.activeEntrants(tournament.id);
    const withCounts = await Promise.all(
      teams.map(async (entrant) => ({ entrant, have: (await deps.tournaments.membersOf(entrant.id)).length })),
    );
    const picker = teamPicker(withCounts, tournament.teamSize);

    await interaction.reply({
      content: picker
        ? 'Выбери команду — вступишь сразу, подтверждения капитана не нужно.'
        : 'Пока никто не набирает состав. Создай свою команду — остальные вступят к тебе.',
      ...(picker ? { components: [picker] } : {}),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Что мне делать: смотрим на состояние именно этого человека.
  const entrant = await deps.tournaments.entrantOfUser(tournament.id, userId);
  const roster = entrant ? await deps.tournaments.membersOf(entrant.id) : [];
  const all = await deps.tournaments.activeEntrants(tournament.id);
  const openCounts = await Promise.all(all.map((row) => deps.tournaments.membersOf(row.id)));

  await interaction.reply({
    content: nextStepText({
      linked: tournament.requireVerified ? await hasVerifiedLink(ctx.db, userId, tournament.game) : true,
      linkCommand: linkCommandFor(tournament.game),
      gameLabel: TOURNAMENT_GAME_LABELS[tournament.game] ?? tournament.game,
      entrant,
      isCaptain: entrant?.captainUserId === userId,
      rosterSize: roster.length,
      teamSize: tournament.teamSize,
      openTeams: openCounts.filter((members) => members.length < tournament.teamSize).length,
      registrationOpen: tournament.state === 'registration',
    }),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTeamNameModal(deps: PlayDeps, interaction: ModalSubmitInteraction): Promise<void> {
  const guild = requireGuild(interaction.guild);
  const tournament = await currentTournament(deps, guild);
  const name = interaction.fields.getTextInputValue('name');

  const entrant = await deps.tournaments.createEntrant(tournament.id, interaction.user.id, name);
  await interaction.reply({
    content: [
      `Команда **${entrant.displayName}** создана, ты капитан.`,
      `Осталось набрать ${tournament.teamSize - 1}: скажи своим нажать **Найти команду** и выбрать вашу.`,
      'Как соберётесь — нажми **Я готов**.',
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTeamPick(deps: PlayDeps, interaction: StringSelectMenuInteraction): Promise<void> {
  const guild = requireGuild(interaction.guild);
  const tournament = await currentTournament(deps, guild);
  const entrantId = Number.parseInt(interaction.values[0] ?? '', 10);
  if (!Number.isInteger(entrantId)) throw new UserError('Не понял, какая это команда.');

  const entrant = await deps.tournaments.joinEntrant(entrantId, interaction.user.id);
  const roster = await deps.tournaments.membersOf(entrant.id);
  const missing = tournament.teamSize - roster.length;

  await interaction.update({
    content: [
      `Ты в составе **${entrant.displayName}** — ${roster.length} из ${tournament.teamSize}.`,
      missing > 0
        ? `Не хватает ещё ${missing}.`
        : 'Состав собран. Осталось, чтобы капитан нажал **Я готов**.',
    ].join('\n'),
    components: [],
  });

  // Состав только что стал полным — подсказываем капитану, иначе команда просто не попадёт
  // в сетку, и человек узнает об этом уже после старта.
  if (missing === 0 && interaction.channel?.isSendable()) {
    await interaction.channel.send(rosterFullNudge(entrant.displayName, entrant.captainUserId));
  }
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
