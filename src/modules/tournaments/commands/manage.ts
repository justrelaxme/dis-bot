import { PermissionFlagsBits, SlashCommandBuilder, type Guild } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition, ModuleContext } from '../../../core/module.js';
import { EVENT_SIZE_LABELS, eventSize } from '../bracket.js';
import { createTournamentRooms } from './play.js';
import type { ChannelsGateway } from '../discord/channels.js';
import { registrationPanel } from '../discord/onboarding.js';
import { TOURNAMENT_GAMES, TOURNAMENT_GAME_LABELS } from '../games.js';
import type { TournamentGame } from '../schema.js';
import { parseClock, type CycleService } from '../services/cycle.js';
import { entrantStrengths } from '../services/strength.js';
import type { TournamentsService } from '../services/tournaments.js';

const REGISTRATION_HOURS_DEFAULT = 4;

export interface ManageDeps {
  tournaments: TournamentsService;
  channels: ChannelsGateway;
  cycles: CycleService;
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
      .addSubcommand((sub) => sub.setName('info').setDescription('Что сейчас происходит с турниром'))
      .addSubcommand((sub) =>
        sub
          .setName('schedule')
          .setDescription('Ежедневный автомат: голосование, регистрация и старт без организатора')
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Включить или выключить автомат'),
          )
          .addStringOption((option) =>
            option.setName('poll_at').setDescription('Когда вывешивать голосование, например 14:00'),
          )
          .addStringOption((option) =>
            option.setName('start_at').setDescription('Когда стартовать, например 20:00'),
          )
          .addIntegerOption((option) =>
            option.setName('poll_hours').setDescription('Сколько часов идёт голосование').setMinValue(1).setMaxValue(12),
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Составы или одиночки')
              .addChoices({ name: 'Команды', value: 'team' }, { name: 'Одиночки', value: 'solo' }),
          )
          .addIntegerOption((option) =>
            option.setName('team_size').setDescription('Игроков в команде').setMinValue(1).setMaxValue(10),
          )
          .addStringOption((option) =>
            option.setName('timezone').setDescription('Часовой пояс, по умолчанию Europe/Berlin'),
          ),
      ),

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
      if (subcommand === 'schedule') {
        await schedule(interaction, guild, deps);
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

  // Панель с кнопками вместо инструкции текстом: новичку не надо разбираться, какую
  // команду набрать, — он нажимает «Что мне делать?» и получает свой следующий шаг.
  const panel = registrationPanel(tournament);
  await interaction.editReply({
    content: [
      panel.content,
      '',
      `Старт <t:${Math.floor(closesAt.getTime() / 1_000)}:t> · сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
    ].join('\n'),
    components: panel.components,
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
  // построенную сетку. Та же функция вызывается при старте по расписанию.
  await createTournamentRooms(deps, guild, tournament.id);

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

/**
 * Настройка ежедневного автомата. Канал объявлений, категория комнат и канал для веток
 * берутся из того места, где вызвали команду: так администратор не подбирает три id
 * руками, а просто пишет команду там, где хочет видеть турниры.
 */
async function schedule(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  const patch: Record<string, unknown> = {};

  const enabled = interaction.options.getBoolean('enabled');
  if (enabled !== null) {
    patch['enabled'] = enabled;
    // Счётчик пустых дней сбрасываем при ручном включении: администратор видит, что
    // никто не приходил, и всё равно включает — значит причина ему известна.
    if (enabled) patch['emptyDays'] = 0;
  }

  for (const [option, field] of [
    ['poll_at', 'pollAt'],
    ['start_at', 'startAt'],
    ['timezone', 'timezone'],
  ] as const) {
    const value = interaction.options.getString(option);
    if (value !== null) patch[field] = value.trim();
  }

  const mode = interaction.options.getString('mode');
  if (mode !== null) patch['entryMode'] = mode === 'solo' ? 'solo' : 'team';

  for (const [option, field] of [
    ['poll_hours', 'pollHours'],
    ['team_size', 'teamSize'],
  ] as const) {
    const value = interaction.options.getInteger(option);
    if (value !== null) patch[field] = value;
  }

  if (interaction.channelId) {
    patch['announceChannelId'] = interaction.channelId;
    patch['matchParentId'] = interaction.channelId;
  }

  const saved = await deps.cycles.upsertSchedule(guild.id, patch);

  // Некорректное время ловим здесь, а не в четыре часа ночи в логе джобы.
  const badClock = [saved.pollAt, saved.startAt].filter((value) => parseClock(value) === null);
  if (badClock.length > 0) {
    throw new UserError(`Время должно быть в виде ЧЧ:ММ. Не разобрал: ${badClock.join(', ')}.`);
  }

  await interaction.editReply({
    content: [
      `## Ежедневный автомат — ${saved.enabled ? 'включён' : 'выключен'}`,
      `Голосование в **${saved.pollAt}** на ${saved.pollHours} ч, старт в **${saved.startAt}** (${saved.timezone}).`,
      `${saved.entryMode === 'team' ? `Команды по ${saved.teamSize}` : 'Одиночки'}, до ${saved.maxEntrants} участников.`,
      `Объявления и ветки матчей — в этом канале.`,
      '',
      saved.enabled
        ? 'Дальше бот ведёт день сам: голосование, условия, регистрация, жеребьёвка, комнаты.'
        : 'Включить: `/tournament schedule enabled:true`.',
    ].join('\n'),
  });
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
