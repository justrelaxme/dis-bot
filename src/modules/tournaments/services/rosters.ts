import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import { budgetVerdict, costOf, formatCost, type CostedCharacter } from '../genshin/cost.js';
import { GENSHIN_ROSTER } from '../draft/pools.js';
import { tournamentRosters, type TournamentRosterRow } from '../schema.js';

/**
 * Заявки составов: кого игрок берёт на турнир и во сколько очков это обошлось.
 *
 * Устройство и причины хранить снимком описаны у таблицы в `schema.ts`. Здесь — правила, и
 * главное из них одно: **потолок проверяет сервер, а не страница**. Страница считает то же
 * самое и показывает остаток, но заявка, пришедшая мимо неё, обязана упереться в тот же
 * предел — иначе потолок не правило, а подсказка.
 */

/** Что игрок прислал: только идентификаторы. Всё остальное берётся из его же Летописи. */
export interface RosterSubmission {
  tournamentId: number;
  userId: string;
  externalId: string | null;
  /** Кого заявляет. Порядок значения не имеет. */
  characterIds: readonly string[];
  /** Кого защищает от бана. Подмножество заявленных, не больше `immunities`. */
  immuneIds?: readonly string[];
  /** Сколько иммунов разрешил организатор. Ноль — иммунов в этом турнире нет. */
  immunities?: number;
  /** Потолок турнира в очках. `null` — без потолка. */
  cap: number | null;
  /** Состав аккаунта из Летописи: по нему считается цена и проверяется владение. */
  owned: readonly (CostedCharacter & { sets?: readonly { name: string; pieces: number }[] | undefined })[];
}

export interface RosterEntry {
  id: string;
  name: string;
  rarity: number;
  constellation: number;
  cost: number;
  /** Адрес иконки из Летописи. Может не прийти — тогда карточка обходится без картинки. */
  iconUrl?: string;
  weapon?: { name: string; rarity: number; refinement: number };
  sets?: string;
}

/** Комплекты одной строкой: «4× Багровая ведьма». Из них показываются значимые, от двух. */
function setsLine(sets: readonly { name: string; pieces: number }[] | undefined): string {
  return (sets ?? [])
    .filter((set) => set.pieces >= 2)
    .map((set) => `${set.pieces}× ${set.name}`)
    .join(', ');
}

/** Персонаж из Летописи в вид заявки: со сборкой и посчитанной ценой. */
export function entryOf(
  character: CostedCharacter & {
    sets?: readonly { name: string; pieces: number }[] | undefined;
    iconUrl?: string | undefined;
  },
): RosterEntry {
  const line = setsLine(character.sets);
  return {
    id: character.id,
    name: character.name,
    rarity: character.rarity,
    constellation: character.constellation,
    cost: costOf(character).total,
    ...(character.iconUrl ? { iconUrl: character.iconUrl } : {}),
    ...(character.weapon
      ? {
          weapon: {
            name: character.weapon.name,
            rarity: character.weapon.rarity,
            refinement: character.weapon.refinement,
          },
        }
      : {}),
    ...(line ? { sets: line } : {}),
  };
}

/**
 * Собирает заявку и проверяет её. Не сохраняет: решение о записи принимает вызывающий, а
 * здесь — только правила, и их три.
 *
 * Заявить можно лишь то, что есть на аккаунте. Иначе смысл заявки теряется целиком: она
 * существует, чтобы соперник знал, из чего выбирали, а не чтобы записать желаемое.
 *
 * Заявка не может быть больше отряда на этаж. Восемь — это две половины по четыре, и
 * девятый персонаж на этаже не сыграет никак.
 *
 * И потолок. Ровно по потолку — влезает; на полочка больше — нет, и в отказе названо, на
 * сколько именно, иначе подбирать пришлось бы наугад.
 */
export function buildRoster(submission: RosterSubmission): {
  characters: RosterEntry[];
  spent: number;
  immune: string[];
} {
  const unique = [...new Set(submission.characterIds)];
  if (unique.length === 0) {
    throw new UserError('Пустой состав заявить нельзя — выбери хотя бы одного персонажа.');
  }
  if (unique.length > GENSHIN_ROSTER) {
    throw new UserError(
      `В заявке максимум ${GENSHIN_ROSTER} персонажей: этаж Бездны проходят двумя половинами по четыре, и девятый на нём не сыграет.`,
    );
  }

  const byId = new Map(submission.owned.map((character) => [character.id, character]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new UserError(
      'В заявке есть персонажи, которых нет на аккаунте. Обнови страницу: состав читается из Летописи, и он мог измениться.',
    );
  }

  const characters = unique.map((id) => entryOf(byId.get(id) as CostedCharacter));
  const spent = Math.round(characters.reduce((sum, entry) => sum + entry.cost, 0) * 10) / 10;

  const verdict = budgetVerdict(spent, submission.cap);
  if (!verdict.fits) {
    throw new UserError(
      `Состав дороже потолка на ${formatCost(verdict.over)} — при потолке ${formatCost(verdict.cap ?? 0)} набралось ${formatCost(spent)}. Убери кого-нибудь или возьми того же персонажа с оружием подешевле.`,
    );
  }

  return { characters, spent, immune: immuneOf(submission, unique) };
}

/**
 * Кого защитить от бана.
 *
 * Два правила, и оба про смысл заявки. Защищать можно только заявленного: иммун на персонажа,
 * которого не берёшь, ничего не значит и означал бы, что человек ошибся. И не больше, чем
 * разрешил организатор — иначе число иммунов задавал бы не он.
 *
 * Лишние отбрасываются молча, а вот превышение — отказ: первое это опечатка в порядке кнопок,
 * второе попытка сыграть не по правилам вечера, и путать их нельзя.
 */
function immuneOf(submission: RosterSubmission, chosen: readonly string[]): string[] {
  const allowed = Math.max(0, Math.trunc(submission.immunities ?? 0));
  const asked = [...new Set(submission.immuneIds ?? [])].filter((id) => chosen.includes(id));

  if (allowed === 0) return [];
  if (asked.length > allowed) {
    throw new UserError(
      `Иммунов можно ${allowed}, а выбрано ${asked.length}. Иммун защищает персонажа от бана соперника, и больше разрешённого взять нельзя.`,
    );
  }
  return asked;
}

export function createRostersService(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Сохраняет заявку. Повторное сохранение правит её, а не заводит вторую: игрок передумал,
     * а не пришёл вторым составом.
     */
    async submit(submission: RosterSubmission): Promise<TournamentRosterRow> {
      const { characters, spent, immune } = buildRoster(submission);

      const [row] = await db
        .insert(tournamentRosters)
        .values({
          tournamentId: submission.tournamentId,
          userId: submission.userId,
          externalId: submission.externalId,
          characters,
          spent,
          immune,
          cap: submission.cap,
        })
        .onConflictDoUpdate({
          target: [tournamentRosters.tournamentId, tournamentRosters.userId],
          set: {
            characters,
            spent,
            immune,
            cap: submission.cap,
            externalId: submission.externalId,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!row) throw new UserError('Заявка не сохранилась — попробуй ещё раз.');
      return row;
    },

    async byPlayer(tournamentId: number, userId: string): Promise<TournamentRosterRow | null> {
      const [row] = await db
        .select()
        .from(tournamentRosters)
        .where(and(eq(tournamentRosters.tournamentId, tournamentId), eq(tournamentRosters.userId, userId)));
      return row ?? null;
    },

    /** Все заявки турнира. Нужны организатору и драфту: из них видно, кто с чем пришёл. */
    async byTournament(tournamentId: number): Promise<TournamentRosterRow[]> {
      return db.select().from(tournamentRosters).where(eq(tournamentRosters.tournamentId, tournamentId));
    },

    /** Убирает заявку. Игрок передумал участвовать — состав не должен за него оставаться. */
    async withdraw(tournamentId: number, userId: string): Promise<void> {
      await db
        .delete(tournamentRosters)
        .where(and(eq(tournamentRosters.tournamentId, tournamentId), eq(tournamentRosters.userId, userId)));
    },
  };
}

export type RostersService = ReturnType<typeof createRostersService>;
