import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import type { BracketFormat, MatchBracket } from './bracket.js';
// Только тип: на выполнении импорт стирается, поэтому взаимная ссылка с pools.ts кольца
// в модулях не образует.
import type { DraftGroup } from './draft/pools.js';

/**
 * Игра турнира — самостоятельный тип модуля, а не ProviderId из identity: турнир
 * проводится по игре, а ProviderId (src/modules/identity/schema.ts) — это источник
 * данных о ранге. Это разные оси: Dota 2 как турнирная дисциплина обслуживается
 * провайдером 'steam', но тащить сюда ProviderId и его остальные значения
 * (riot-lol/riot-tft/riot-valorant вперемешку с future 'other' и т.п.) means
 * привязывать голосование по дисциплине к устройству модуля identity, которое
 * может меняться по совсем другим причинам.
 */
export type TournamentGame = 'dota2' | 'lol' | 'tft' | 'valorant';

export const tournamentPolls = pgTable(
  'tournament_polls',
  {
    id: serial('id').primaryKey(),
    // Снежинки Discord хранятся как text — guildId намеренно без FK на guilds.id:
    // в проекте пока нет ни одного места, которое гарантированно создаёт строку в
    // guilds при появлении бота на сервере (см. отчёт), и голосование не должно
    // зависеть от этого пробела.
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    /** Дисциплины, предложенные на голосование, в том же порядке, что и ответы опроса Discord. */
    options: jsonb('options').$type<TournamentGame[]>().notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    /**
     * NULL, пока итог не зафиксирован. Остаётся NULL и после фиксации, если исход —
     * ничья между несколькими дисциплинами или ни одного голоса: в обоих случаях
     * нет одной выигравшей дисциплины, но голосование всё равно обработано
     * (см. finalizedAt).
     */
    winnerGame: text('winner_game').$type<TournamentGame>(),
    /**
     * Признак того, что итог уже объявлен в Discord — единственный источник истины
     * для джобы о том, нужно ли ещё что-то делать с этим голосованием. Именно эта
     * колонка, а не наличие winnerGame: у ничьей и нулевых голосов winnerGame тоже
     * NULL, но обрабатывать их повторно не нужно.
     */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Джоба каждые несколько минут ищет именно эту пару условий — без индекса это
    // полное сканирование таблицы на каждый тик планировщика.
    index('tournament_polls_due_idx').on(table.finalizedAt, table.closesAt),
    // Один Discord-message — одно голосование.
    unique('tournament_polls_message_uq').on(table.messageId),
  ],
);

/** Колонка, а не enum: Swiss добавится значением, без миграции типа. */
export type TournamentFormat = BracketFormat;

export type EntryMode = 'solo' | 'team';

export type TournamentState = 'draft' | 'registration' | 'running' | 'finished' | 'cancelled';

export type SeedingMode = 'random' | 'rank';

/**
 * `pending` — соперники ещё не известны, предыдущий круг не сыгран. `ready` — оба
 * известны, можно играть. `reported` — кто-то заявил результат. `confirmed` — соперник
 * подтвердил либо сработало автоподтверждение. `disputed` — оспорено, решает организатор.
 * `walkover` — неявка или пропуск: победа присуждена без игры.
 *
 * `void` — матч не состоится вовсе, потому что в него никто не придёт. Такое бывает только
 * в нижней сетке неполного турнира: пропуск в верхней не даёт проигравшего, а значит место,
 * куда он должен был спуститься, останется пустым навсегда. Отличать это состояние от
 * `pending` обязательно — иначе нижняя сетка встанет, ожидая соперника, которого нет.
 */
export type MatchState =
  | 'pending'
  | 'ready'
  | 'reported'
  | 'confirmed'
  | 'disputed'
  | 'walkover'
  | 'void';

/** Стадия суточного цикла. `skipped` — день пропущен, причина в `skipReason`. */
export type CycleStage = 'poll' | 'registration' | 'running' | 'finished' | 'skipped';

export const tournaments = pgTable(
  'tournaments',
  {
    id: serial('id').primaryKey(),
    // Как и у голосований: без FK на guilds.id, потому что строку в guilds никто
    // гарантированно не создаёт при появлении бота на сервере.
    guildId: text('guild_id').notNull(),
    name: text('name').notNull(),
    game: text('game').$type<TournamentGame>().notNull(),
    format: text('format').$type<TournamentFormat>().notNull().default('single-elim'),
    entryMode: text('entry_mode').$type<EntryMode>().notNull(),
    /** Сколько игроков в составе. Для solo всегда 1. */
    teamSize: integer('team_size').notNull().default(1),
    maxEntrants: integer('max_entrants').notNull().default(16),
    seeding: text('seeding').$type<SeedingMode>().notNull().default('rank'),
    state: text('state').$type<TournamentState>().notNull().default('draft'),
    /** Число карт в матче: 1, 3 или 5. Одинаково для всех матчей турнира. */
    bestOf: integer('best_of').notNull().default(1),
    /**
     * Играют ли со способностями.
     *
     * Выключенные способности — это не оттенок правил, а другая игра: дуэль в Valorant «на
     * любом агенте, чисто пострелять» проверяет прицел, и делить там нечего. Поэтому у такого
     * турнира драфта нет вовсе — ни агентов, ни карты. Обещать вето там, где выбор ни на что
     * не влияет, значило бы заставлять капитанов нажимать кнопки без причины.
     *
     * По умолчанию включены: обычный турнир играется со способностями, а дуэль на прицел —
     * отдельный случай, который организатор задаёт осознанно.
     */
    abilities: boolean('abilities').notNull().default(true),
    /**
     * Собирает ли бот составы сам из тех, кто записался по одному.
     *
     * Нужно там, где компании нет: человек хочет играть пять на пять, но своей четвёрки у него
     * не наберётся. Раздача идёт по силе, чтобы составы вышли ровными, — случайная одинаково
     * часто даёт и ровные, и пятёрку сильнейших против пятёрки слабейших, а второй случай это
     * испорченный вечер для десяти человек.
     *
     * Смысл имеет только у командного турнира: в матче один на один делить нечего.
     */
    autoTeams: boolean('auto_teams').notNull().default(false),
    /** Требовать подтверждённую привязку по игре у каждого игрока состава. */
    requireVerified: boolean('require_verified').notNull().default(true),
    /**
     * Чемпион. Хранится, а не выводится из последнего матча: «кто победил» — это факт о
     * турнире, который спрашивают чаще всего, и зал славы не должен для каждой строки
     * разбирать форму сетки. Заполняется тем же обновлением, что закрывает турнир.
     */
    winnerEntrantId: integer('winner_entrant_id'),
    announceChannelId: text('announce_channel_id'),
    /**
     * Событие Discord — афиша турнира во вкладке «События».
     *
     * Дублирует объявление, а не заменяет его: событие само напоминает, показывает отсчёт и
     * даёт отметить интерес, но кнопок в нём нет, поэтому регистрация и драфт остаются
     * сообщением и страницей. `null` — событие не создалось (нет права «Управление
     * событиями») или дисциплина обошлась без него; на ход турнира это не влияет.
     */
    scheduledEventId: text('scheduled_event_id'),
    /** Категория, в которой создаются голосовые каналы команд. */
    teamCategoryId: text('team_category_id'),
    /** Канал, в котором создаются ветки под матчи. */
    matchParentId: text('match_parent_id'),
    createdBy: text('created_by').notNull(),
    registrationClosesAt: timestamp('registration_closes_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tournaments_guild_state_idx').on(table.guildId, table.state)],
);

/**
 * Единое понятие для одиночек и команд — ключевое решение всей модели. Сетка сводит
 * участников, а участник это либо один игрок, либо команда. Развилка «соло или команда»
 * живёт только в регистрации; движок сетки, продвижение победителя и репорт результатов
 * о ней не знают вовсе, поэтому один турнир на 16 команд и один на 16 одиночек идут по
 * совершенно одинаковому коду.
 */
export const tournamentEntrants = pgTable(
  'tournament_entrants',
  {
    id: serial('id').primaryKey(),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    /** Ник игрока или название команды. */
    displayName: text('display_name').notNull(),
    captainUserId: text('captain_user_id').notNull(),
    /** Место в жеребьёвке, 1 — сильнейший. Заполняется при старте. */
    seed: integer('seed'),
    /** Сила состава на момент жеребьёвки (из rankScore этапа 1) — хранится для витрины. */
    seedScore: integer('seed_score'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    /** Снятие не удаляет строку: сетка уже могла быть построена по этому участнику. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    /** Голосовой канал команды. Уборка идёт по этому id, а не по имени: имя переименуют. */
    voiceChannelId: text('voice_channel_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tournament_entrants_name_uq').on(table.tournamentId, table.displayName),
    unique('tournament_entrants_captain_uq').on(table.tournamentId, table.captainUserId),
    index('tournament_entrants_tournament_idx').on(table.tournamentId),
  ],
);

/**
 * `tournamentId` здесь денормализован намеренно: без него ограничение «один человек не
 * играет за две команды одного турнира» пришлось бы проверять запросом, а проверка
 * запросом — это гонка между двумя одновременными вступлениями. Пусть гарантирует база.
 */
export const tournamentEntrantMembers = pgTable(
  'tournament_entrant_members',
  {
    id: serial('id').primaryKey(),
    entrantId: integer('entrant_id')
      .notNull()
      .references(() => tournamentEntrants.id, { onDelete: 'cascade' }),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').$type<'captain' | 'player' | 'sub'>().notNull().default('player'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tournament_members_entrant_user_uq').on(table.entrantId, table.userId),
    unique('tournament_members_tournament_user_uq').on(table.tournamentId, table.userId),
  ],
);

export const tournamentMatches = pgTable(
  'tournament_matches',
  {
    id: serial('id').primaryKey(),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    /**
     * Какая это сетка. У single elimination всё в `upper`. У double elimination проигравшие
     * спускаются в `lower`, а победители обеих встречаются в единственном матче `grand`.
     */
    bracket: text('bracket').$type<MatchBracket>().notNull().default('upper'),
    /** 1 — первый круг. Нумерация своя в каждой сетке. */
    round: integer('round').notNull(),
    /** Позиция в круге, с нуля. */
    slot: integer('slot').notNull(),
    entrantAId: integer('entrant_a_id'),
    entrantBId: integer('entrant_b_id'),
    winnerEntrantId: integer('winner_entrant_id'),
    state: text('state').$type<MatchState>().notNull().default('pending'),
    /**
     * Счёт матча. Необязателен, и это осознанно: бот не может его проверить, а требовать
     * обязательное поле, которое всё равно вводят руками, значит выбирать между «наврал» и
     * «не смог отчитаться». Победителя по-прежнему называют отдельно — счёт его только
     * поясняет, а не заменяет.
     *
     * Заполняется тем же обновлением, что закрывает матч: до подтверждения заявленный счёт
     * лежит в `reportedScore*`, как и заявленный победитель.
     */
    scoreA: integer('score_a'),
    scoreB: integer('score_b'),
    /** Кто заявил результат: нужен, чтобы тот же человек не мог его же и подтвердить. */
    reportedBy: text('reported_by'),
    reportedWinnerId: integer('reported_winner_id'),
    reportedScoreA: integer('reported_score_a'),
    reportedScoreB: integer('reported_score_b'),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    disputedAt: timestamp('disputed_at', { withTimezone: true }),
    /** Ветка матча: пускает обе команды пары, иначе соперники не договорятся о лобби. */
    threadId: text('thread_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Позиция включает сетку: первый круг верхней и первый круг нижней — разные матчи.
    unique('tournament_matches_position_uq').on(
      table.tournamentId,
      table.bracket,
      table.round,
      table.slot,
    ),
    // Джоба автоподтверждения выбирает заявленные и давно — без индекса это скан.
    index('tournament_matches_reported_idx').on(table.state, table.reportedAt),
  ],
);

/** Каждый репорт и каждое решение отдельной строкой — для разбора споров, не для показа. */
export const tournamentMatchReports = pgTable('tournament_match_reports', {
  id: serial('id').primaryKey(),
  matchId: integer('match_id')
    .notNull()
    .references(() => tournamentMatches.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  claimedWinnerId: integer('claimed_winner_id'),
  action: text('action')
    .$type<'report' | 'confirm' | 'dispute' | 'resolve' | 'walkover' | 'auto-confirm' | 'verified'>()
    .notNull(),
  /** true — решение принял организатор, а не участник. */
  byOrganizer: boolean('by_organizer').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Сообщения, которые бот отправил по поводу турнира.
 *
 * Нужны, чтобы за собой убрать. Ежедневный турнир оставляет в канале объявлений панель
 * регистрации с живыми кнопками, напоминание неотметившимся и голосование — за неделю это
 * канал, в котором не найти сегодняшнее. А панель с кнопками хуже простого сора: по ней
 * нажимают через сутки и не понимают, почему ничего не происходит.
 *
 * Поэтому у каждого сообщения есть пометка: сор или запись. **Сор удаляется, запись
 * остаётся.** Итог турнира и пары первого круга — это летопись, и стирать её значило бы
 * стирать то, ради чего турнир проводили. Решение принимается на отправке, а не при уборке:
 * тот, кто отправляет, знает, что именно он отправил.
 *
 * Уникальность `(channelId, messageId)` — защита от повторной записи одного сообщения:
 * джобы идемпотентны, и один и тот же вызов может дойти дважды.
 */
export const tournamentMessages = pgTable(
  'tournament_messages',
  {
    id: serial('id').primaryKey(),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    /** true — сор: панель с кнопками, напоминание, голосование. false — запись: итог, пары. */
    transient: boolean('transient').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tournament_messages_uq').on(table.channelId, table.messageId),
    index('tournament_messages_sweep_idx').on(table.tournamentId, table.transient),
  ],
);

/**
 * Суточный цикл. Уникальность `(guildId, cycleDate)` — и есть защита от того, что
 * перезапуск процесса, наложение прогонов или повторная доставка дадут два голосования
 * за один день. Проверка запросом означала бы гонку между двумя прогонами.
 *
 * Таблица ещё и отвечает на вопрос «что вообще было вчера»: без неё разбирать, почему
 * турнира не случилось, пришлось бы по логам.
 */
export const tournamentCycles = pgTable(
  'tournament_cycles',
  {
    id: serial('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    cycleDate: date('cycle_date').notNull(),
    stage: text('stage').$type<CycleStage>().notNull().default('poll'),
    pollId: integer('poll_id'),
    tournamentId: integer('tournament_id'),
    /** Почему день пропущен: играть некому, прошлый турнир не закрыт, расписание выключено. */
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tournament_cycles_day_uq').on(table.guildId, table.cycleDate)],
);

/**
 * Времена суточного цикла — строки в таблице, а не константы в коде: ежедневный автомат,
 * время которого нельзя поменять без правки кода и перезапуска, придётся править в первый
 * же день, когда окажется, что в 20:00 на сервере никого.
 *
 * `enabled` по умолчанию false: автомат, включающийся сам сразу после миграции, устроил бы
 * турнир на сервере, который к нему не готов.
 */
export const tournamentSchedules = pgTable('tournament_schedules', {
  guildId: text('guild_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** Часовой пояс, в котором понимаются времена ниже: сервер может стоять в UTC. */
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  /** «14:00» — когда вывешивать голосование. */
  pollAt: text('poll_at').notNull().default('14:00'),
  pollHours: integer('poll_hours').notNull().default(2),
  /** «20:00» — когда закрывать регистрацию и строить сетку. */
  startAt: text('start_at').notNull().default('20:00'),
  entryMode: text('entry_mode').$type<EntryMode>().notNull().default('team'),
  /**
   * У ежедневного автомата по умолчанию выбывание с первого поражения, и это не про
   * «так проще». Двойное устранение примерно удваивает длину вечера: восьми командам
   * нужно шесть волн матчей вместо трёх, то есть старт в 20:00 заканчивается около
   * полуночи. Для будней это много, для события выходного дня — нормально, поэтому
   * формат вынесен в настройку, а не зашит.
   */
  format: text('format').$type<BracketFormat>().notNull().default('single-elim'),
  teamSize: integer('team_size').notNull().default(5),
  maxEntrants: integer('max_entrants').notNull().default(16),
  bestOf: integer('best_of').notNull().default(1),
  /** Играют ли со способностями. Выключены — драфта у турнира нет вовсе. */
  abilities: boolean('abilities').notNull().default(true),
  /** Собирает ли бот составы сам из записавшихся по одному. */
  autoTeams: boolean('auto_teams').notNull().default(false),
  requireVerified: boolean('require_verified').notNull().default(true),
  games: jsonb('games').$type<TournamentGame[]>().notNull(),
  announceChannelId: text('announce_channel_id'),
  teamCategoryId: text('team_category_id'),
  matchParentId: text('match_parent_id'),
  /** Сколько дней подряд никто не приходил: на пороге автомат встаёт сам. */
  emptyDays: integer('empty_days').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Драфт перед матчем: вето карт в Valorant, баны и пики героев в Dota.
 *
 * Пул и последовательность хранятся **снимком** в самой строке, а не берутся из кода при
 * каждом чтении. Список героев меняется с патчем, пул карт Riot ротирует — и драфт,
 * сыгранный месяц назад, должен остаться читаемым ровно таким, каким был. Иначе запись,
 * ради которой драфт и заводился, перестанет быть записью.
 *
 * Токены — способ узнать капитана без входа на сайт. Витрина по устройству анонимна и
 * только для чтения, а драфт требует знать, кто нажимает: банить за команду может лишь её
 * капитан. Ссылку с токеном раздаёт бот в личные сообщения, то есть право действовать
 * по-прежнему выдаёт Discord — как и всё остальное управление.
 */
export const matchDrafts = pgTable(
  'tournament_match_drafts',
  {
    id: serial('id').primaryKey(),
    matchId: integer('match_id')
      .notNull()
      .references(() => tournamentMatches.id, { onDelete: 'cascade' }),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    /**
     * Первая фаза драфта, она же набор по умолчанию для шагов без пометки. У Valorant после
     * карт идут агенты, и их шаги помечены своим набором в самой последовательности.
     */
    subject: text('subject').$type<'heroes' | 'maps'>().notNull(),
    /** Снимок пула на момент создания: патч не должен переписывать прошлое. */
    pool: jsonb('pool')
      .$type<
        { id: string; label: string; imageUrl?: string; iconUrl?: string; group?: DraftGroup }[]
      >()
      .notNull(),
    sequence: jsonb('sequence')
      .$type<{ side: 'a' | 'b'; kind: 'ban' | 'pick'; group?: DraftGroup }[]>()
      .notNull(),
    tokenA: text('token_a').notNull(),
    tokenB: text('token_b').notNull(),
    /** Докуда ждём текущий ход. Пустой дедлайн — драфт ещё не начали или уже закончили. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Один матч — один драфт. Второй драфт того же матча означал бы два протокола, и
    // спорящие принесли бы каждый свой.
    unique('tournament_match_drafts_match_uq').on(table.matchId),
    unique('tournament_match_drafts_token_a_uq').on(table.tokenA),
    unique('tournament_match_drafts_token_b_uq').on(table.tokenB),
    // Джоба таймаутов выбирает по этой паре.
    index('tournament_match_drafts_due_idx').on(table.completedAt, table.deadlineAt),
  ],
);

/**
 * Журнал выборов. Он же и есть состояние драфта: «чей ход» выводится из числа сделанных
 * шагов, а не хранится отдельно — второй источник истины однажды разошёлся бы с первым и
 * оставил драфт без выхода.
 *
 * Уникальность `(draftId, step)` — защита от двух одновременных нажатий: оба вычислят один
 * и тот же номер шага, но вставка удастся только одному. Та же схема, что у всех остальных
 * гонок в проекте: условие в базе, а не проверка перед записью.
 */
export const draftChoices = pgTable(
  'tournament_draft_choices',
  {
    id: serial('id').primaryKey(),
    draftId: integer('draft_id')
      .notNull()
      .references(() => matchDrafts.id, { onDelete: 'cascade' }),
    step: integer('step').notNull(),
    side: text('side').$type<'a' | 'b'>().notNull(),
    kind: text('kind').$type<'ban' | 'pick'>().notNull(),
    /** NULL — ход пропущен: на бане это законно, время вышло. */
    optionId: text('option_id'),
    /** NULL — выбрал не человек, а таймаут. */
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tournament_draft_choices_step_uq').on(table.draftId, table.step)],
);

export type TournamentRow = typeof tournaments.$inferSelect;
export type MatchDraftRow = typeof matchDrafts.$inferSelect;
export type TournamentMessageRow = typeof tournamentMessages.$inferSelect;
export type DraftChoiceRow = typeof draftChoices.$inferSelect;
export type EntrantRow = typeof tournamentEntrants.$inferSelect;
export type EntrantMemberRow = typeof tournamentEntrantMembers.$inferSelect;
export type MatchRow = typeof tournamentMatches.$inferSelect;
export type PollRow = typeof tournamentPolls.$inferSelect;
export type CycleRow = typeof tournamentCycles.$inferSelect;
export type ScheduleRow = typeof tournamentSchedules.$inferSelect;
