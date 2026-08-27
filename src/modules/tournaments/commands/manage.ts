import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type Guild } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition, ModuleContext } from '../../../core/module.js';
import { BRACKET_FORMAT_LABELS, EVENT_SIZE_LABELS, eventSize } from '../bracket.js';
import { closeTournamentRooms, createTournamentRooms, type CleanupReport } from './play.js';
import type { ChannelsGateway } from '../discord/channels.js';
import { TOURNAMENT_GAMES, TOURNAMENT_GAME_LABELS } from '../games.js';
import type { TournamentFormat, TournamentFormatRow, TournamentGame } from '../schema.js';
import { parseClock, type CycleService } from '../services/cycle.js';
import { bricksOf, type FormatsService } from '../services/formats.js';
import { defaultName, launchTournament } from '../services/launch.js';
import { explainAnnounceFailure, type TournamentEventsGateway } from '../discord/events.js';
import type { MessagesService } from '../services/messages.js';
import { entrantStrengths } from '../services/strength.js';
import type { TournamentsService } from '../services/tournaments.js';

const REGISTRATION_HOURS_DEFAULT = 4;

/**
 * Цена формата названа прямо в выборе. Организатор решает не «какая сетка красивее», а
 * сколько продлится вечер: двойное устранение это шесть волн матчей на восемь команд
 * вместо трёх, зато проигравший первый матч не уходит домой.
 */
const FORMAT_CHOICES = [
  { name: 'Второй шанс — проигравший идёт в нижнюю сетку, вечер вдвое дольше', value: 'double-elim' },
  { name: 'На выбывание — одно поражение и всё, зато быстро', value: 'single-elim' },
] as const;

export interface ManageDeps {
  tournaments: TournamentsService;
  channels: ChannelsGateway;
  cycles: CycleService;
  /** Публичный адрес витрины: в объявлениях даём ссылку на сетку. */
  publicBaseUrl: string;
  /** Учёт отправленных сообщений — чтобы убрать панель регистрации после турнира. */
  messages?: MessagesService;
  /** Афиша во вкладке «События»: ставится при создании, снимается при отмене. */
  events?: TournamentEventsGateway;
  /**
   * Сохранённые форматы турнира и выдача пропусков в конструктор на сайте. Необязательны:
   * без них `/tournament create` работает как раньше, по опциям команды.
   */
  formats?: FormatsService;
  grants?: { issue(input: { guildId: string; userId: string; scope: 'formats' }): Promise<{ token: string; expiresAt: Date }> };
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
          // Сохранённый формат идёт первым: с ним остальные опции не нужны, и это должно быть
          // видно до того, как организатор начнёт заполнять их по одной.
          .addStringOption((option) =>
            option
              .setName('preset')
              .setDescription('Сохранённый формат — остальное можно не заполнять')
              .setAutocomplete(true),
          )
          // Дисциплина и режим перестали быть обязательными: у формата они свои. Без формата
          // их отсутствие — понятная ошибка, а не молчаливый турнир «непонятно по чему».
          .addStringOption((option) =>
            option
              .setName('game')
              .setDescription('Дисциплина')
              .addChoices(...TOURNAMENT_GAMES.map((game) => ({ name: TOURNAMENT_GAME_LABELS[game], value: game }))),
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
          .addIntegerOption((option) =>
            option.setName('max_entrants').setDescription('Максимум участников').setMinValue(2).setMaxValue(64),
          )
          .addIntegerOption((option) =>
            option.setName('hours').setDescription('Сколько часов идёт регистрация').setMinValue(1).setMaxValue(72),
          )
          .addStringOption((option) =>
            option
              .setName('format')
              .setDescription('Сетка: со вторым шансом или на выбывание')
              .addChoices(...FORMAT_CHOICES),
          )
          .addBooleanOption((option) =>
            option
              .setName('abilities')
              .setDescription('Играют со способностями. Выключить — дуэль на прицел, драфта не будет'),
          )
          .addBooleanOption((option) =>
            option
              .setName('auto_teams')
              .setDescription('Составы собирает бот из записавшихся по одному, по силе'),
          )
          .addStringOption((option) =>
            option.setName('name').setDescription('Название турнира').setMaxLength(90),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('formats')
          .setDescription('Конструктор форматов: собрать формат из кирпичиков и сохранить'),
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
          .addBooleanOption((option) =>
            option
              .setName('abilities')
              .setDescription('Играют со способностями. Выключить — дуэль на прицел, драфта не будет'),
          )
          .addBooleanOption((option) =>
            option
              .setName('auto_teams')
              .setDescription('Составы собирает бот из записавшихся по одному, по силе'),
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
            option
              .setName('format')
              .setDescription('Сетка ежедневного турнира')
              .addChoices(...FORMAT_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('timezone').setDescription('Часовой пояс, по умолчанию Europe/Berlin'),
          )
          .addStringOption((option) =>
            option
              .setName('preset')
              .setDescription('Взять настройки из сохранённого формата')
              .setAutocomplete(true),
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
      if (subcommand === 'formats') {
        await formatsLink(interaction, guild, deps);
        return;
      }
      if (subcommand === 'start') {
        await start(interaction, guild, deps, ctx);
        return;
      }
      if (subcommand === 'cancel') {
        await cancel(interaction, guild, deps, ctx);
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

const NL = String.fromCharCode(10);

/**
 * Формат по имени — или внятный отказ. Имя приходит из автодополнения, но прийти может и
 * набранным руками: подсказка не обязательство, и опечатка не должна выглядеть как сбой.
 */
async function requirePreset(
  deps: ManageDeps,
  guildId: string,
  name: string,
): Promise<TournamentFormatRow> {
  if (!deps.formats) {
    throw new UserError('Сохранённые форматы на этом сервере недоступны.');
  }
  const preset = await deps.formats.byName(guildId, name);
  if (!preset) {
    const all = await deps.formats.list(guildId);
    throw new UserError(
      all.length === 0
        ? 'Сохранённых форматов пока нет. Собери первый: `/tournament formats`.'
        : `Формата «${name}» нет. Есть: ${all.map((row) => row.name).join(', ')}.`,
    );
  }
  return preset;
}

/**
 * Ссылка в конструктор форматов. Ответ эфемерный и остаётся таким намеренно: ссылка — это и
 * есть право менять форматы сервера, а сообщение в канале переслал бы его всем, кто это
 * сообщение видит.
 */
async function formatsLink(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  if (!deps.grants) {
    throw new UserError('Конструктор форматов на этом сервере не подключён.');
  }

  const grant = await deps.grants.issue({
    guildId: guild.id,
    userId: interaction.user.id,
    scope: 'formats',
  });
  const saved = deps.formats ? await deps.formats.list(guild.id) : [];

  await interaction.editReply({
    content: [
      '## Конструктор форматов',
      `${deps.publicBaseUrl}/formats/${grant.token}`,
      '',
      `**Ссылка личная и действует до <t:${Math.floor(grant.expiresAt.getTime() / 1_000)}:t>.** Кто её откроет, тот и меняет форматы сервера — не пересылай. Новая ссылка гасит эту, так что отозвать доступ всегда можно этой же командой.`,
      '',
      saved.length === 0
        ? 'Сохранённых форматов пока нет. Собери первый — дальше турнир запускается по имени: `/tournament create preset:Имя`.'
        : `Сохранено форматов: ${saved.length}. Запуск: \`/tournament create preset:${saved[0]?.name ?? 'Имя'}\`.`,
    ].join(NL),
  });
}

async function create(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  /**
   * Сохранённый формат — заготовка, а не рамка: указанная явно опция перебивает его. Иначе
   * пришлось бы держать отдельный формат на каждое «то же самое, но на восьмерых», и вместо
   * шести осмысленных имён в списке оказалось бы тридцать.
   */
  const presetName = interaction.options.getString('preset');
  const preset = presetName ? await requirePreset(deps, guild.id, presetName) : null;
  const base = preset ? bricksOf(preset) : null;

  const game = (interaction.options.getString('game') ?? base?.game ?? null) as TournamentGame | null;
  if (game === null) {
    throw new UserError(
      preset
        ? `В формате «${preset.name}» дисциплина не задана — добавь опцию \`game\`, она нужна для драфта и жеребьёвки.`
        : 'Укажи дисциплину или сохранённый формат, в котором она есть: `/tournament formats` — конструктор.',
    );
  }

  const modeOption = interaction.options.getString('mode');
  const mode = modeOption === null ? (base?.entryMode ?? 'team') : modeOption === 'solo' ? 'solo' : 'team';
  const teamSize =
    interaction.options.getInteger('team_size') ?? (mode === 'solo' ? 1 : (base?.teamSize ?? 5));
  const maxEntrants = interaction.options.getInteger('max_entrants') ?? base?.maxEntrants ?? 16;
  const hours =
    interaction.options.getInteger('hours') ?? base?.registrationHours ?? REGISTRATION_HOURS_DEFAULT;
  const name = interaction.options.getString('name') ?? defaultName(game, preset?.name);
  // У турнира, который организатор ставит руками, по умолчанию второй шанс: это событие,
  // а не будничный вечер, и приходить ради одного матча обидно. У автомата наоборот —
  // там по умолчанию выбывание, чтобы вечер укладывался в разумное время.
  const format = (interaction.options.getString('format') ??
    base?.format ??
    'double-elim') as TournamentFormat;
  // Со способностями по умолчанию: обычный турнир играется ими, а дуэль на прицел —
  // отдельный случай, который организатор выбирает осознанно.
  const abilities = interaction.options.getBoolean('abilities') ?? base?.abilities ?? true;
  const autoTeams = interaction.options.getBoolean('auto_teams') ?? base?.autoTeams ?? false;

  // Счётчик запусков — учёт, а не часть турнира: по нему сортируется список форматов, и
  // отказ базы здесь не повод не проводить вечер.
  if (preset && deps.formats) {
    await deps.formats.markUsed(preset.id).catch(() => {});
  }

  const result = await launchTournament(
    { tournaments: deps.tournaments, publicBaseUrl: deps.publicBaseUrl, ...(deps.messages ? { messages: deps.messages } : {}), ...(deps.events ? { events: deps.events } : {}) },
    guild,
    {
      settings: {
        name,
        game,
        format,
        entryMode: mode,
        teamSize,
        maxEntrants,
        seeding: base?.seeding ?? 'rank',
        bestOf: base?.bestOf ?? 1,
        abilities,
        autoTeams,
        requireVerified: base?.requireVerified ?? true,
        costCap: base?.costCap ?? null,
        immunities: base?.immunities ?? 0,
        registrationHours: hours,
      },
      // Комнаты заводятся там, где вызвали команду: организатор набирает её в том канале, где
      // хочет видеть турнир, и подбирать три идентификатора руками ему не приходится.
      places: {
        ...(interaction.channelId ? { announceChannelId: interaction.channelId, matchParentId: interaction.channelId } : {}),
      },
      createdBy: interaction.user.id,
      // Панель — это и есть ответ на команду: организатор набрал её в нужном канале, и
      // отправлять туда же вторым сообщением значило бы дублировать саму себя.
      deliver: async (message) => {
        const sent = await interaction.editReply(message);
        return { channelId: sent.channelId, messageId: sent.id };
      },
    },
  );

  // О неудаче афиши организатор узнаёт здесь же — он и есть тот, кто может выдать боту право.
  if (result.billboard && !result.billboard.ok) {
    await interaction.followUp({
      content: explainAnnounceFailure(result.billboard.reason),
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function start(interaction: Interaction, guild: Guild, deps: ManageDeps, ctx: ModuleContext): Promise<void> {
  const tournament = await deps.tournaments.current(guild.id);
  if (!tournament) throw new UserError('Сейчас нет турнира, который можно стартовать.');

  // Автосбор: одиночки превращаются в составы до жеребьёвки. Силу после этого считаем заново —
  // она теперь у команд, а не у отдельных людей, и старая карта указывала бы на участников,
  // которых больше нет.
  let assembled = { teams: 0, benched: [] as string[] };
  if (tournament.autoTeams) {
    const before = await entrantStrengths(ctx.db, tournament.id, tournament.game);
    assembled = await deps.tournaments.assembleTeams(tournament.id, before);
  }

  const strengths = await entrantStrengths(ctx.db, tournament.id, tournament.game);
  const view = await deps.tournaments.start(tournament.id, strengths);
  const active = view.entrants.filter((entrant) => entrant.withdrawnAt === null && entrant.seed !== null);
  const size = eventSize(active.length);

  // Комнаты создаём после того, как сетка уже в базе: отказ Discord не должен отменять
  // построенную сетку. Та же функция вызывается при старте по расписанию.
  await createTournamentRooms(deps, guild, tournament.id);

  // Только верхняя сетка: у нижней в момент старта соперников ещё нет — они появятся
  // из проигравших, а первый круг объявления это про то, кто играет сейчас.
  const firstRound = view.matches.filter((match) => match.bracket === 'upper' && match.round === 1);

  const pairs = firstRound
    .filter((match) => match.entrantAId !== null && match.entrantBId !== null)
    .map((match) => {
      const a = view.entrants.find((entrant) => entrant.id === match.entrantAId);
      const b = view.entrants.find((entrant) => entrant.id === match.entrantBId);
      return `• ${a?.displayName ?? '?'} — ${b?.displayName ?? '?'}`;
    });

  const byes = firstRound
    .filter((match) => match.state === 'walkover')
    .map((match) => {
      const lone = match.winnerEntrantId;
      const entrant = view.entrants.find((row) => row.id === lone);
      return `• ${entrant?.displayName ?? '?'} проходит без игры`;
    });

  // Формат берётся из турнира после старта: при двух отметившихся двойное устранение
  // выродилось в выбывание, и обещать второй шанс, которого не будет, нельзя.
  const doubleElim = view.tournament.format === 'double-elim';

  await interaction.editReply({
    content: [
      `## ${tournament.name} — старт`,
      `${EVENT_SIZE_LABELS[size]} · ${active.length} участников · ${BRACKET_FORMAT_LABELS[view.tournament.format]} · жеребьёвка по силе состава`,
      ...(assembled.teams > 0
        ? [
            '',
            `Составы собрал бот: ${assembled.teams} по ${view.tournament.teamSize}, раздача по силе.`,
            ...(assembled.benched.length > 0
              ? [
                  `Не хватило на полный состав: ${assembled.benched.map((id) => `<@${id}>`).join(', ')} — в сетку не попали.`,
                ]
              : []),
          ]
        : []),
      '',
      '**Первый круг:**',
      ...pairs,
      ...(byes.length > 0 ? ['', ...byes] : []),
      '',
      doubleElim
        ? 'Проигравший не уходит: он попадает в нижнюю сетку и может дойти до финала оттуда. Выбывание — со второго поражения.'
        : 'Одно поражение — и всё: сетка на выбывание.',
      `Победитель матча пишет \`/match report\`, соперник подтверждает. Молчание час — результат принимается сам.`,
      `Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
    ].join('\n'),
  });
}

async function cancel(
  interaction: Interaction,
  guild: Guild,
  deps: ManageDeps,
  ctx: ModuleContext,
): Promise<void> {
  const tournament = await deps.tournaments.current(guild.id);
  if (!tournament) throw new UserError('Сейчас нет турнира, который можно отменить.');

  // Афишу снимаем до отмены: после неё турнир уже не найти по «текущему».
  if (deps.events && tournament.scheduledEventId) {
    await deps.events.cancel(guild, tournament.scheduledEventId);
  }

  // Уборка идёт до смены состояния: она читает участников турнира, и делать это надо, пока
  // турнир ещё считается текущим — иначе порядок начинает иметь значение молча.
  const report = await closeTournamentRooms(deps, guild, tournament.id, ctx.logger, 'delete');
  await deps.tournaments.cancel(tournament.id);

  await interaction.editReply({ content: `Турнир «${tournament.name}» отменён. ${describeCleanup(report)}` });
}

/**
 * Отчёт об уборке словами. Раньше здесь стояло «комнаты убраны» независимо от того, убралось
 * ли что-нибудь: боту не хватало права «Управление каналами», а организатор видел бодрый
 * отчёт и комнаты на своих местах. Врать про сделанное хуже, чем признаться в отказе.
 */
function describeCleanup(report: CleanupReport): string {
  const parts: string[] = [];
  if (report.rooms.found > 0) parts.push(`комнат убрано ${report.rooms.removed} из ${report.rooms.found}`);
  if (report.threads.found > 0) parts.push(`веток ${report.threads.removed} из ${report.threads.found}`);
  if (report.messages > 0) parts.push(`сообщений ${report.messages}`);
  if (parts.length === 0) return 'Убирать было нечего: ни комнат, ни веток он не успел завести.';

  const failed =
    report.rooms.found - report.rooms.removed + (report.threads.found - report.threads.removed);
  const tail =
    failed > 0
      ? ' Остальное Discord удалить не дал — чаще всего это отсутствующее право «Управление каналами».'
      : '';
  return `Убрано: ${parts.join(', ')}.${tail}`;
}

/**
 * Настройка ежедневного автомата. Канал объявлений, категория комнат и канал для веток
 * берутся из того места, где вызвали команду: так администратор не подбирает три id
 * руками, а просто пишет команду там, где хочет видеть турниры.
 */
async function schedule(interaction: Interaction, guild: Guild, deps: ManageDeps): Promise<void> {
  const patch: Record<string, unknown> = {};

  /**
   * Сохранённый формат кладётся в правку первым: указанные тут же опции перебивают его,
   * потому что стоят в объекте после. Порядок здесь несёт смысл, и менять его нельзя.
   *
   * Дисциплина из формата в расписание не переносится намеренно: её выбирает голосование, и
   * прибить её к расписанию значило бы отменить голосование, не сказав об этом.
   */
  const presetName = interaction.options.getString('preset');
  if (presetName) {
    const preset = await requirePreset(deps, guild.id, presetName);
    const base = bricksOf(preset);
    patch['entryMode'] = base.entryMode;
    patch['teamSize'] = base.teamSize;
    patch['maxEntrants'] = base.maxEntrants;
    patch['format'] = base.format;
    patch['bestOf'] = base.bestOf;
    patch['abilities'] = base.abilities;
    patch['autoTeams'] = base.autoTeams;
    patch['requireVerified'] = base.requireVerified;
  }

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

  const abilities = interaction.options.getBoolean('abilities');
  if (abilities !== null) patch['abilities'] = abilities;

  const autoTeams = interaction.options.getBoolean('auto_teams');
  if (autoTeams !== null) patch['autoTeams'] = autoTeams;

  const format = interaction.options.getString('format');
  if (format !== null) patch['format'] = format === 'double-elim' ? 'double-elim' : 'single-elim';

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

  // Исход последнего дня. Он и отвечает на «включил, а на следующий день ничего не
  // произошло»: причина пропуска пишется в базу, но до этого её никто не показывал, и
  // выяснять приходилось по логам на сервере.
  const last = await deps.cycles.lastDay(guild.id);
  const lastLine = ((): string | null => {
    if (!last) return null;
    const when = String(last.cycleDate);
    if (last.stage === 'skipped') {
      return `⚠️ Последний день (${when}) **пропущен**: ${last.skipReason ?? 'причина не записана'}.`;
    }
    const stages: Record<string, string> = {
      poll: 'идёт голосование',
      registration: 'открыта регистрация',
      running: 'турнир идёт',
      finished: 'турнир доигран',
    };
    return `Последний день (${when}): ${stages[last.stage] ?? last.stage}.`;
  })();

  await interaction.editReply({
    content: [
      `## Ежедневный автомат — ${saved.enabled ? 'включён' : 'выключен'}`,
      `Голосование в **${saved.pollAt}** на ${saved.pollHours} ч, старт в **${saved.startAt}** (${saved.timezone}).`,
      `${saved.entryMode === 'team' ? `Команды по ${saved.teamSize}` : 'Одиночки'}, до ${saved.maxEntrants} участников.`,
      `Объявления и ветки матчей — в этом канале.`,
      ...(lastLine ? ['', lastLine] : []),
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

  // Режим и формат здесь обязательны: без них проверить, что именно создалось, было
  // нечем — а перепутать «Команды» и «Одиночки» в выпадающем списке легко, и обнаруживалось
  // это только по панели регистрации, когда люди уже начали записываться.
  const roster =
    tournament.entryMode === 'solo'
      ? `играют по одному${tournament.abilities ? '' : ', способности выключены — дуэль на прицел'}`
      : `команды по ${tournament.teamSize} человек${tournament.abilities ? '' : ', способности выключены'}`;

  await interaction.editReply({
    content: [
      `## ${tournament.name}`,
      `${TOURNAMENT_GAME_LABELS[tournament.game]} · ${tournament.state === 'registration' ? 'идёт регистрация' : 'идёт'}`,
      `${roster} · ${BRACKET_FORMAT_LABELS[tournament.format]} · максимум ${tournament.maxEntrants}`,
      `Участников: ${entrants.length}, отметилось ${checked}.`,
      tournament.state === 'registration'
        ? 'Не тот режим — `/tournament cancel` и создать заново: состав в уже открытом турнире менять нельзя, за него могли начать записываться.'
        : null,
      `Сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
    ]
      .filter((line) => line !== null)
      .join('\n'),
  });
}
