import { PermissionFlagsBits, SlashCommandBuilder, type Guild } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition, ModuleContext } from '../../../core/module.js';
import { EVENT_SIZE_LABELS, eventSize } from '../bracket.js';
import type { ChannelsGateway } from '../discord/channels.js';
import { TOURNAMENT_GAMES, TOURNAMENT_GAME_LABELS } from '../games.js';
import type { TournamentGame } from '../schema.js';
import { entrantStrengths } from '../services/strength.js';
import type { TournamentsService } from '../services/tournaments.js';

const REGISTRATION_HOURS_DEFAULT = 4;

export interface ManageDeps {
  tournaments: TournamentsService;
  channels: ChannelsGateway;
  /** Публичный адрес витрины: в объявлениях даём ссылку на сетку. */
  publicBaseUrl: string;
}

function requireGuild(guild: Guild | null): Guild {
  if (!guild) throw new UserError('Эта команда работает только на сервере.');
  return guild;
}

/**
 * Административная часть `/tournament`. Голосование (`poll`) живёт в отдельном файле и
 * подмешивается сюда манифестом: Discord допускает только одну команду с именем
 * `tournament`, поэтому все её подкоманды обязаны быть объявлены в одном билдере.
 */
export function createManageCommand(deps: ManageDeps, pollExecute: CommandDefinition['execute']): CommandDefinition {
  return {
    // Публично: объявление турнира и итог голосования должны быть видны в канале.
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('tournament')
      .setDescription('Турниры сервера')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('poll')
          .setDescription('Запустить голосование по дисциплине турнира')
          .addIntegerOption((option) =>
            option
              .setName('hours')
              .setDescription('Длительность голосования в часах')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(168),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Создать турнир и открыть регистрацию')
          .addStringOption((option) =>
            option
              .setName('game')
              .setDescription('Дисциплина')
              .setRequired(true)
              .addChoices(...TOURNAMENT_GAMES.map((game) => ({ name: TOURNAMENT_GAME_LABELS[game], value: game }))),
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Составы или одиночки')
              .setRequired(true)
              .addChoices({ name: 'Команды', value: 'team' }, { name: 'Одиночки', value: 'solo' }),
          )
          .addIntegerOption((option) =>
            option.setName('team_size').setDescription('Игроков в команде').setMinValue(1).setMaxValue(10),
          )
          .addIntegerOption((option) =>
            option.setName('max_entrants').setDescription('Максимум участников').setMinValue(2).setMaxValue(64),
          )
          .addIntegerOption((option) =>
            option.setName('hours').setDescription('Сколько часов идёт регистрация').setMinValue(1).setMaxValue(72),
          )
          .addStringOption((option) =>
            option.setName('name').setDescription('Название турнира').setMaxLength(90),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('start').setDescription('Закрыть регистрацию, разложить сетку и объявить первый круг'),
      )
      .addSubcommand((sub) => sub.setName('cancel').setDescription('Отменить текущий турнир и убрать его комнаты'))
      .addSubcommand((sub) => sub.setName('info').setDescription('Что сейчас происходит с турниром')),

    async execute(interaction, ctx): Promise<void> {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'poll') {
        await pollExecute(interaction, ctx);
        return;
      }

      const guild = requireGuild(interaction.guild);

      if (subcommand === 'create') {
        await create(interaction, guild, deps);
        return;
      }
      if (subcommand === 'start') {
        await start(interaction, guild, deps, ctx);
        return;
      }
      if (subcommand === 'cancel') {
        await cancel(interaction, guild, deps);
        return;
      }
      if (subcommand === 'info') {
        await info(interaction, guild, deps);
        return;
      }
      throw new UserError('Неизвестная подкоманда.');
    },
  };
}

type Interaction = Parameters<CommandDefinition['execute']>[0];

async function create(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  // Второй одновременный турнир — это участники в двух сетках сразу и невозможность
  // понять, к какому турниру относится /match report.
  const running = await deps.tournaments.current(guild.id);
  if (running) {
    throw new UserError(`На сервере уже есть турнир «${running.name}». Сначала заверши или отмени его.`);
  }

  const game = interaction.options.getString('game', true) as TournamentGame;
  const mode = interaction.options.getString('mode', true) === 'solo' ? 'solo' : 'team';
  const teamSize = interaction.options.getInteger('team_size') ?? (mode === 'solo' ? 1 : 5);
  const maxEntrants = interaction.options.getInteger('max_entrants') ?? 16;
  const hours = interaction.options.getInteger('hours') ?? REGISTRATION_HOURS_DEFAULT;
  const name = interaction.options.getString('name') ?? `Турнир по ${TOURNAMENT_GAME_LABELS[game]}`;

  const tournament = await deps.tournaments.create({
    guildId: guild.id,
    name,
    game,
    entryMode: mode,
    teamSize,
    maxEntrants,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: true,
    createdBy: interaction.user.id,
    ...(interaction.channelId ? { announceChannelId: interaction.channelId } : {}),
    ...(interaction.channelId ? { matchParentId: interaction.channelId } : {}),
  });

  const closesAt = new Date(Date.now() + hours * 60 * 60 * 1_000);
  await deps.tournaments.openRegistration(tournament.id, closesAt);

  // Условия участия — отдельный шаг, а не приписка: человек, впервые зашедший на сервер,
  // должен понять из одного сообщения, что делать.
  const howTo =
    mode === 'team'
      ? [
          `**Как попасть.** Капитан пишет \`/team create\` с названием — бот вывесит карточку команды с кнопкой «Вступить». Остальные жмут кнопку сами, приглашать никого не надо.`,
          `**Состав:** ${teamSize} человек. Нужна подтверждённая привязка ${TOURNAMENT_GAME_LABELS[game]} у каждого — делается командой \`/link\`.`,
          `**Перед старом** капитан отмечает состав командой \`/checkin\`. Не отметились — в сетку не попадёте.`,
        ]
      : [
          `**Как попасть.** Напиши \`/team create\` со своим ником — этого достаточно, состав тут не нужен.`,
          `**Нужна подтверждённая привязка** ${TOURNAMENT_GAME_LABELS[game]} — делается командой \`/link\`.`,
          `**Перед старом** отметься командой \`/checkin\`.`,
        ];

  await interaction.editReply({
    content: [
      `## ${name}`,
      `${TOURNAMENT_GAME_LABELS[game]} · ${mode === 'team' ? `команды по ${teamSize}` : 'одиночки'} · до ${maxEntrants} участников`,
      `Регистрация открыта до <t:${Math.floor(closesAt.getTime() / 1_000)}:t>.`,
      '',
      ...howTo,
      '',
      `Сетка и результаты: ${deps.publicBaseUrl}/t/${tournament.id}`,
    ].join('\n'),
  });
}

async function start(interaction: Interaction, guild: Guild, deps: ManageDeps, ctx: ModuleContext): Promise<void> {
  const tournament = await deps.tournaments.current(guild.id);
  if (!tournament) throw new UserError('Сейчас нет турнира, который можно стартовать.');

  const strengths = await entrantStrengths(ctx.db, tournament.id, tournament.game);
  const view = await deps.tournaments.start(tournament.id, strengths);
  const active = view.entrants.filter((entrant) => entrant.withdrawnAt === null && entrant.seed !== null);
  const size = eventSize(active.length);

  // Комнаты создаём после того, как сетка уже в базе: отказ Discord не должен отменять
  // построенную сетку.
  for (const entrant of active) {
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

  const pairs = view.matches
    .filter((match) => match.round === 1 && match.entrantAId !== null && match.entrantBId !== null)
    .map((match) => {
      const a = view.entrants.find((entrant) => entrant.id === match.entrantAId);
      const b = view.entrants.find((entrant) => entrant.id === match.entrantBId);
      return `• ${a?.displayName ?? '?'} — ${b?.displayName ?? '?'}`;
    });

  const byes = view.matches
    .filter((match) => match.round === 1 && match.state === 'walkover')
    .map((match) => {
      const lone = match.winnerEntrantId;
      const entrant = view.entrants.find((row) => row.id === lone);
      return `• ${entrant?.displayName ?? '?'} проходит без игры`;
    });

  await interaction.editReply({
    content: [
      `## ${tournament.name} — старт`,
      `${EVENT_SIZE_LABELS[size]} · ${active.length} участников · жеребьёвка по силе состава`,
      '',
      '**Первый круг:**',
      ...pairs,
      ...(byes.length > 0 ? ['', ...byes] : []),
      '',
      `Победитель матча пишет \`/match report\`, соперник подтверждает. Молчание час — результат принимается сам.`,
      `Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
    ].join('\n'),
  });
}

async function cancel(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  const tournament = await deps.tournaments.current(guild.id);
  if (!tournament) throw new UserError('Сейчас нет турнира, который можно отменить.');

  const entrants = await deps.tournaments.activeEntrants(tournament.id);
  await deps.tournaments.cancel(tournament.id);

  for (const entrant of entrants) {
    if (entrant.voiceChannelId) await deps.channels.deleteChannel(guild, entrant.voiceChannelId);
  }

  await interaction.editReply({ content: `Турнир «${tournament.name}» отменён, комнаты убраны.` });
}

async function info(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  const tournament = await deps.tournaments.current(guild.id);
  if (!tournament) {
    await interaction.editReply({ content: 'Сейчас турнира нет. Создать: `/tournament create`.' });
    return;
  }

  const entrants = await deps.tournaments.activeEntrants(tournament.id);
  const checked = entrants.filter((entrant) => entrant.checkedInAt !== null).length;

  await interaction.editReply({
    content: [
      `## ${tournament.name}`,
      `${TOURNAMENT_GAME_LABELS[tournament.game]} · ${tournament.state === 'registration' ? 'идёт регистрация' : 'идёт'}`,
      `Участников: ${entrants.length} из ${tournament.maxEntrants}, отметилось ${checked}.`,
      `Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
    ].join('\n'),
  });
}
