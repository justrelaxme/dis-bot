import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import { BRACKET_FORMAT_LABELS, EVENT_SIZE_LABELS, effectiveFormat, eventSize } from '../bracket.js';
import { draftSubject, GENSHIN_ROSTER, SUBJECT_LABELS } from '../draft/pools.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import {
  tournamentFormats,
  type EntryMode,
  type SeedingMode,
  type TournamentFormat,
  type TournamentFormatRow,
  type TournamentGame,
} from '../schema.js';

/**
 * Сохранённые форматы турнира.
 *
 * Главная работа этого файла — не хранение, а проверки и описание. Формат живёт долго и
 * запускается много раз, поэтому противоречие внутри него стоит дороже, чем ошибка в одном
 * турнире: «одиночки по пять человек в составе» испортит не один вечер, а все вечера, пока
 * кто-нибудь не догадается посмотреть в настройки.
 *
 * Проверять это надо там, где формат собирают, а не там, где применяют: в момент сборки
 * человек ещё помнит, что имел в виду. Поэтому и предпросмотр на сайте считается **этим же**
 * кодом, а не отдельной копией на странице: копия разошлась бы с настоящим турниром на первой
 * же правке, и обещание «вот что получится» перестало бы быть обещанием.
 */

/** Больше — уже не список, а свалка: в таком выбирают поиском, а не глазами. */
export const MAX_FORMATS_PER_GUILD = 25;
const NAME_MAX = 60;
const NOTE_MAX = 200;
const ALLOWED_BEST_OF = [1, 3, 5];
/**
 * Дороже восьмёрки лимитированных C6 с сигнатурными оружиями R5 состав не бывает: 8 × (7 + 5).
 * Потолок выше этого ничего не ограничивает и означает, что человек ошибся полем.
 */
const MAX_COST_CAP = 96;

export interface FormatBricks {
  game?: TournamentGame | null | undefined;
  entryMode: EntryMode;
  teamSize: number;
  maxEntrants: number;
  format: TournamentFormat;
  bestOf: number;
  seeding?: SeedingMode;
  abilities?: boolean;
  autoTeams?: boolean;
  requireVerified?: boolean;
  registrationHours?: number;
  /**
   * Потолок стоимости состава в очках — только у Genshin. `null` означает «без потолка»:
   * играют чем есть, и это обычный турнир.
   *
   * Смысл потолка в том, что игра одиночная и аккаунты разные: без него побеждает тот, кто
   * больше вложил, а не тот, кто лучше играет. Система очков — в `genshin/cost.ts`.
   */
  costCap?: number | null | undefined;
  /**
   * Сколько персонажей игрок может защитить от бана. Ноль — иммунов нет, банить можно кого
   * угодно. Правило из турниров сообщества: каждый называет своих неприкасаемых.
   */
  immunities?: number | undefined;
  note?: string | null;
}

export type NormalizedBricks = Omit<
  Required<FormatBricks>,
  'note' | 'game' | 'costCap' | 'immunities'
> & {
  game: TournamentGame | null;
  costCap: number | null;
  /** Всегда число: не заданное превращается в ноль при согласовании. */
  immunities: number;
  note: string | null;
};

/**
 * Приводит набор к согласованному виду и отказывается от невозможного.
 *
 * Часть противоречий поправима без вопросов: у одиночного турнира состав всегда из одного, и
 * спрашивать об этом незачем. Часть поправить нельзя, не выдумав за человека — «составы
 * собирает бот» в турнире один на один означает либо что режим указан неверно, либо что
 * настройка лишняя, и угадывать, что именно, значит решать за организатора.
 */
export function normalizeBricks(bricks: FormatBricks): NormalizedBricks {
  const entryMode = bricks.entryMode;
  const requestedSize = Math.trunc(bricks.teamSize);

  if (entryMode === 'team' && requestedSize < 2) {
    throw new UserError(
      'В командном формате в составе минимум двое. Для игры по одному выбери режим «Одиночки».',
    );
  }
  if (entryMode === 'team' && requestedSize > 10) {
    throw new UserError('В составе максимум десять: больше не бывает ни в одной из дисциплин.');
  }

  // Состав из одного и есть одиночный турнир — поправляем молча, другого смысла у этого нет.
  const teamSize = entryMode === 'solo' ? 1 : requestedSize;
  const maxEntrants = Math.trunc(bricks.maxEntrants);
  const registrationHours = Math.trunc(bricks.registrationHours ?? 2);
  const autoTeams = bricks.autoTeams ?? false;

  if (maxEntrants < 2 || maxEntrants > 64) {
    throw new UserError('Участников от 2 до 64: меньше двух играть не с кем, больше 64 сетка не строит.');
  }
  if (!ALLOWED_BEST_OF.includes(bricks.bestOf)) {
    throw new UserError('Карт в матче может быть 1, 3 или 5 — счёт всегда до победы в половине плюс одна.');
  }
  if (registrationHours < 1 || registrationHours > 72) {
    throw new UserError('Регистрация идёт от часа до трёх суток.');
  }
  if (autoTeams && entryMode === 'solo') {
    throw new UserError(
      'Автосбор составов работает только в командном формате: в матче один на один собирать нечего. Либо режим «Команды», либо выключи автосбор.',
    );
  }
  if (bricks.note && bricks.note.length > NOTE_MAX) {
    throw new UserError(`Заметка к формату — не длиннее ${NOTE_MAX} символов.`);
  }

  /**
   * Иммунов не может быть больше, чем персонажей в отряде: восемь иммунов при восьми пиках
   * отменяют баны целиком, и такой драфт превращается в обмен ходами без смысла. Предел на
   * единицу меньше — так у банов всегда остаётся хотя бы одна цель.
   */
  const immunities = Math.min(GENSHIN_ROSTER - 1, Math.max(0, Math.trunc(bricks.immunities ?? 0)));

  // Потолок бывает половинным: стандартный пятизвёздочный C0 стоит 0.5 очка. Округляем до
  // половины, а не до целого — иначе половина системы очков просто не выражается.
  const costCap =
    bricks.costCap === null || bricks.costCap === undefined
      ? null
      : Math.round(Math.max(0, bricks.costCap) * 2) / 2;
  if (costCap !== null && costCap > MAX_COST_CAP) {
    throw new UserError(
      `Потолок стоимости больше ${MAX_COST_CAP} очков не имеет смысла: дороже восьмёрки лимитированных C6 с сигнатурками не бывает вовсе.`,
    );
  }

  return {
    immunities,
    game: bricks.game ?? null,
    entryMode,
    teamSize,
    maxEntrants,
    format: bricks.format,
    bestOf: bricks.bestOf,
    seeding: bricks.seeding ?? 'rank',
    abilities: bricks.abilities ?? true,
    autoTeams,
    requireVerified: bricks.requireVerified ?? true,
    registrationHours,
    costCap,
    note: bricks.note?.trim() ? bricks.note.trim() : null,
  };
}

/**
 * Предупреждения — то, что не запрещено, но почти наверняка не то, чего человек хотел.
 *
 * Отказом их делать нельзя: у каждого есть законное применение. Промолчать тоже нельзя —
 * именно такие настройки потом выглядят как поломка бота, а не как выбор организатора.
 */
export function warningsFor(bricks: NormalizedBricks): string[] {
  const warnings: string[] = [];

  // Настройка означает что-то только у Valorant: у Dota и Genshin способности в самой игре не
  // выключаются. Молчать об этом нельзя — переключатель стоит у всех дисциплин.
  if (!bricks.abilities && (bricks.game === 'valorant' || bricks.game === null)) {
    warnings.push('Способности выключены — у Valorant это дуэль на прицел, и драфта у неё не будет.');
  }
  if (!bricks.abilities && bricks.game !== null && bricks.game !== 'valorant') {
    warnings.push('Способности выключены, но в этой дисциплине настройка ни на что не влияет — драфт будет.');
  }
  // Этаж Бездны проходит один человек своей четвёркой. Командный турнир по Genshin означает,
  // что заявки составов не будет ни у кого: она привязана к человеку, а не к пятёрке.
  if (bricks.game === 'genshin' && bricks.entryMode === 'team') {
    warnings.push(
      'Genshin командой: этаж Бездны проходит один человек, и заявки составов у команд не будет. Скорее всего нужен режим «Одиночки».',
    );
  }
  if (bricks.entryMode === 'team' && !bricks.autoTeams) {
    warnings.push('Автосбор выключен: составы собирают капитаны, и записаться в одиночку не выйдет.');
  }
  if (bricks.format === 'double-elim' && bricks.bestOf > 1) {
    warnings.push(
      'Второй шанс вместе с матчами до двух побед — это вечер часов на пять: волн матчей вдвое больше, и каждая длиннее.',
    );
  }
  if (bricks.maxEntrants > 32) {
    warnings.push('Больше 32 участников — это шесть кругов сетки. Проверь, что вечер выдержит.');
  }
  if (!bricks.requireVerified) {
    warnings.push('Подтверждённая привязка не нужна — в жеребьёвке такие игроки идут без ранга.');
  }
  if (bricks.game === null) {
    warnings.push('Дисциплина не задана: её выберут при запуске или голосованием. Это нормально для автомата.');
  }
  // Бюджет считается по созвездиям и оружию из Летописи, а её у остальных дисциплин нет.
  if (bricks.costCap !== null && bricks.game !== null && bricks.game !== 'genshin') {
    warnings.push('Бюджет состава работает только в Genshin — в этой дисциплине он ни на что не влияет.');
  }
  if (bricks.costCap === 0) {
    warnings.push('Бюджет ноль: пройдут только составы целиком из четырёхзвёздочных. Это жёстко, но законно.');
  }
  if (bricks.immunities > 0 && bricks.game !== null && bricks.game !== 'genshin') {
    warnings.push('Иммуны работают только в Genshin — в этой дисциплине они ни на что не влияют.');
  }
  if (bricks.immunities >= GENSHIN_ROSTER - 2 && bricks.immunities > 0) {
    warnings.push(
      `Иммунов ${bricks.immunities} при восьми пиках — банить почти нечего. Обычно берут один-два.`,
    );
  }

  return warnings;
}

/**
 * Сколько волн матчей займёт вечер при полной сетке.
 *
 * На выбывание это `log2(участники)` округлённое вверх. У двойного устранения нижняя сетка
 * добавляет примерно столько же плюс гранд-финал — считаем по верхней границе, потому что
 * планировать вечер надо по худшему случаю, а не по среднему.
 */
export function waveCount(maxEntrants: number, format: TournamentFormat): number {
  if (maxEntrants < 2) return 0;
  const upper = Math.ceil(Math.log2(maxEntrants));
  return format === 'double-elim' ? upper * 2 + 1 : upper;
}

export interface FormatPreview {
  /** Одна фраза: что это за событие. Ровно то, что увидит организатор при запуске. */
  headline: string;
  /** По строке на каждую заметную черту формата. */
  lines: string[];
  warnings: string[];
}

/**
 * Что получится, если запустить формат прямо сейчас. Считается по тем же функциям, что
 * строят настоящий турнир: `eventSize`, `effectiveFormat`, `draftSubject`.
 */
export function previewOf(bricks: NormalizedBricks): FormatPreview {
  const size = eventSize(bricks.maxEntrants);
  const actual = effectiveFormat(bricks.maxEntrants, bricks.format);
  const people = bricks.entryMode === 'solo' ? bricks.maxEntrants : bricks.maxEntrants * bricks.teamSize;
  const waves = waveCount(bricks.maxEntrants, actual);

  const roster =
    bricks.entryMode === 'solo'
      ? `${bricks.maxEntrants} одиночек`
      : `${bricks.maxEntrants} составов по ${bricks.teamSize}`;

  const lines = [
    `Сетка: ${BRACKET_FORMAT_LABELS[actual]}, до ${waves} ${waves === 1 ? 'волны' : 'волн'} матчей.`,
    `Матч: ${bricks.bestOf === 1 ? 'одна карта' : `до ${Math.ceil(bricks.bestOf / 2)} побед из ${bricks.bestOf}`}.`,
    `Мест: ${roster} — это до ${people} человек.`,
    `Регистрация: ${bricks.registrationHours} ${bricks.registrationHours === 1 ? 'час' : 'ч'}.`,
    bricks.seeding === 'rank'
      ? 'Жеребьёвка по рангу: сильные разведены по краям сетки.'
      : 'Жеребьёвка случайная.',
  ];

  // Драфт зависит и от дисциплины, и от способностей — там, где его не будет, лучше сказать
  // прямо: организатор иначе ждёт полотно с пиками, а его нет, и это выглядит поломкой.
  if (bricks.game === null) {
    lines.push('Драфт: зависит от дисциплины, а она пока не задана.');
  } else if (bricks.game === 'valorant' && !bricks.abilities) {
    // Только у Valorant: там выключенные способности означают дуэль на прицел, где делить
    // нечего. В остальных дисциплинах способности в игре не выключаются, и драфт остаётся.
    lines.push('Драфт: нет — способности выключены, играется дуэль на прицел.');
  } else {
    const subject = draftSubject(bricks.game);
    lines.push(
      subject === null
        ? 'Драфт: у этой дисциплины его нет.'
        : `Драфт: ${SUBJECT_LABELS[subject].many}, баны и пики перед матчем.`,
    );
  }

  if (bricks.entryMode === 'team') {
    lines.push(
      bricks.autoTeams
        ? 'Составы: бот соберёт их из записавшихся по одному, по силе.'
        : 'Составы: собирают капитаны.',
    );
  }

  // Потолок стоимости — то, что делает турнир по Genshin соревнованием, а не сравнением
  // вложений. Молчать о нём в предпросмотре значило бы прятать главное правило вечера.
  if (bricks.costCap !== null) {
    lines.push(
      `Бюджет состава: ${bricks.costCap} очков. Четырёхзвёздочные бесплатны, лимитированный C0 стоит 1, его сигнатурка R1 — ещё 1.`,
    );
  }
  if (bricks.immunities > 0) {
    lines.push(
      `Иммуны: ${bricks.immunities} на игрока — этих соперник забанить не сможет. Кого именно, каждый выбирает в своей заявке.`,
    );
  }

  const game = bricks.game === null ? 'Дисциплина по выбору' : TOURNAMENT_GAME_LABELS[bricks.game];
  const headline = `${game} · ${EVENT_SIZE_LABELS[size]} на ${roster}`;

  return { headline, lines, warnings: warningsFor(bricks) };
}

/** Настройки формата в том виде, в котором их принимает создание турнира. */
export function bricksOf(row: TournamentFormatRow): NormalizedBricks {
  return {
    game: row.game,
    entryMode: row.entryMode,
    teamSize: row.teamSize,
    maxEntrants: row.maxEntrants,
    format: row.format,
    bestOf: row.bestOf,
    seeding: row.seeding,
    abilities: row.abilities,
    autoTeams: row.autoTeams,
    requireVerified: row.requireVerified,
    registrationHours: row.registrationHours,
    costCap: row.costCap,
    immunities: row.immunities,
    note: row.note,
  };
}

export function createFormatsService(deps: { db: Database }) {
  const { db } = deps;

  async function byName(guildId: string, name: string): Promise<TournamentFormatRow | null> {
    const [row] = await db
      .select()
      .from(tournamentFormats)
      .where(and(eq(tournamentFormats.guildId, guildId), eq(tournamentFormats.name, name.trim())));
    return row ?? null;
  }

  async function count(guildId: string): Promise<number> {
    const rows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(tournamentFormats)
      .where(eq(tournamentFormats.guildId, guildId));
    return rows[0]?.total ?? 0;
  }

  return {
    byName,
    count,

    /**
     * Сохраняет формат. Повторное имя — правка, а не второй формат: организатор, сохраняющий
     * «Вечерний» второй раз, хочет поменять «Вечерний», а не завести «Вечерний (2)», в
     * котором через месяц не разберётся никто.
     */
    async save(input: {
      guildId: string;
      name: string;
      createdBy: string;
      bricks: FormatBricks;
    }): Promise<{ row: TournamentFormatRow; created: boolean; preview: FormatPreview }> {
      const name = input.name.trim();
      if (name.length === 0 || name.length > NAME_MAX) {
        throw new UserError(`Имя формата — от одного до ${NAME_MAX} символов.`);
      }

      const bricks = normalizeBricks(input.bricks);
      const existing = await byName(input.guildId, name);

      if (!existing) {
        const total = await count(input.guildId);
        if (total >= MAX_FORMATS_PER_GUILD) {
          throw new UserError(
            `Форматов уже ${total} — больше ${MAX_FORMATS_PER_GUILD} на сервер не храним: в таком списке всё равно не выбрать. Убери ненужный.`,
          );
        }
      }

      const [row] = await db
        .insert(tournamentFormats)
        .values({ guildId: input.guildId, name, createdBy: input.createdBy, ...bricks })
        .onConflictDoUpdate({
          // Автор и счётчик запусков не перезаписываются: правка формата не отменяет того,
          // что по нему играли, и не переписывает, кто его придумал.
          target: [tournamentFormats.guildId, tournamentFormats.name],
          set: { ...bricks, updatedAt: new Date() },
        })
        .returning();

      if (!row) throw new UserError('Формат не сохранился — попробуй ещё раз.');
      return { row, created: existing === null, preview: previewOf(bricks) };
    },

    /** Сверху то, чем правда пользуются: сортировка по запускам, а не по алфавиту. */
    async list(guildId: string): Promise<TournamentFormatRow[]> {
      return db
        .select()
        .from(tournamentFormats)
        .where(eq(tournamentFormats.guildId, guildId))
        .orderBy(desc(tournamentFormats.usedCount), desc(tournamentFormats.updatedAt));
    },

    async byId(guildId: string, id: number): Promise<TournamentFormatRow | null> {
      const [row] = await db
        .select()
        .from(tournamentFormats)
        .where(and(eq(tournamentFormats.guildId, guildId), eq(tournamentFormats.id, id)));
      return row ?? null;
    },

    async rename(guildId: string, id: number, name: string): Promise<TournamentFormatRow> {
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
        throw new UserError(`Имя формата — от одного до ${NAME_MAX} символов.`);
      }
      const clash = await byName(guildId, trimmed);
      if (clash && clash.id !== id) {
        throw new UserError(`Формат «${trimmed}» на сервере уже есть.`);
      }
      const [row] = await db
        .update(tournamentFormats)
        .set({ name: trimmed, updatedAt: new Date() })
        .where(and(eq(tournamentFormats.guildId, guildId), eq(tournamentFormats.id, id)))
        .returning();
      if (!row) throw new UserError('Такого формата на сервере нет.');
      return row;
    },

    async remove(guildId: string, id: number): Promise<TournamentFormatRow> {
      const [row] = await db
        .delete(tournamentFormats)
        .where(and(eq(tournamentFormats.guildId, guildId), eq(tournamentFormats.id, id)))
        .returning();
      if (!row) throw new UserError('Такого формата на сервере нет.');
      return row;
    },

    /**
     * Отмечает запуск. Счётчик не украшение: по нему список и сортируется, иначе сверху
     * оказывается формат, который назвали первым, а не тот, которым играют.
     */
    async markUsed(id: number): Promise<void> {
      await db
        .update(tournamentFormats)
        .set({ usedCount: sql`${tournamentFormats.usedCount} + 1`, lastUsedAt: new Date() })
        .where(eq(tournamentFormats.id, id));
    },
  };
}

export type FormatsService = ReturnType<typeof createFormatsService>;
