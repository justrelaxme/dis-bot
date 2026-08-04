import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Cache } from '../../../core/cache.js';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Logger } from '../../../core/logger.js';
import {
  autoChoice,
  canChoose,
  draftView,
  type DraftChoice,
  type DraftView,
} from '../draft/engine.js';
import {
  VALORANT_MAPS,
  bansFor,
  draftSubject,
  mapVetoSequence,
  pickBanSequence,
  picksFor,
  poolFits,
  type DraftOption,
  type DraftSide,
  type DraftStep,
} from '../draft/pools.js';
import {
  draftChoices,
  matchDrafts,
  tournamentMatches,
  type DraftChoiceRow,
  type MatchDraftRow,
  type MatchRow,
  type TournamentRow,
} from '../schema.js';

/** Сколько ждём один ход. Минута: хватает подумать и мало, чтобы никого не мучить. */
export const STEP_TIMEOUT_MS = 60_000;

const OPENDOTA_HEROES = 'https://api.opendota.com/api/heroes';
const HERO_CACHE_KEY = 'dota:heroes';
/** Сутки: списки меняются с патчем, а патчи выходят не чаще. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * Портреты героев с CDN Valve. Путь `dota_react` — единственный, который есть у всех героев:
 * старые вертикальные портреты (`heroes/<slug>_vert.jpg`) Valve перестал публиковать для
 * добавленных после 2021 года, и Marci с Muerta там просто нет. Проверено по всему списку.
 */
const HERO_IMAGE_BASE =
  'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';

const VALORANT_AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const AGENT_CACHE_KEY = 'valorant:agents';

/**
 * Справочник персонажей Genshin. У HoYoverse публичного API нет вообще, поэтому берётся
 * выгрузка Enka.Network: два файла, потому что имена в игровых данных лежат хэшами, а
 * расшифровка хэшей — отдельным словарём локализаций. Русские имена есть только там.
 */
const ENKA_CHARACTERS_URL =
  'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json';
const ENKA_LOC_URL = 'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/loc.json';
const CHARACTER_CACHE_KEY = 'genshin:characters';

/**
 * Справочник чемпионов League of Legends — Data Dragon, официальная выгрузка Riot. Двумя
 * запросами: пути в ней прибиты к версии патча, и версию сначала надо узнать. Захардкоженная
 * версия устарела бы через две недели и утащила бы за собой все картинки.
 */
const DDRAGON_VERSIONS = 'https://ddragon.leagueoflegends.com/api/versions.json';
const CHAMPION_CACHE_KEY = 'lol:champions';
/**
 * Картинки персонажей раздаёт та же Enka: у HoYoverse публичного CDN с портретами нет.
 * Ссылка стоит здесь, а не берётся из витрины, потому что зависимость обратная — витрина
 * импортирует пул карт отсюда, и импорт в другую сторону замкнул бы её на саму себя.
 */
const GENSHIN_IMAGE_BASE = 'https://enka.network/ui';

interface OpenDotaHero {
  id: number;
  name: string;
  localized_name: string;
}

interface ValorantAgent {
  uuid: string;
  displayName: string;
  killfeedPortrait: string | null;
  displayIcon: string | null;
}

interface DataDragonChampions {
  data: Record<string, { id: string; name: string }>;
}

interface EnkaCharacter {
  NameTextMapHash: number;
  /** Имя файла мелкой иконки, например `UI_AvatarIcon_Side_Ayaka`. Портрет — то же без `_Side`. */
  SideIconName?: string;
  Element?: string;
  QualityType?: string;
}

export interface DraftState {
  draft: MatchDraftRow;
  choices: DraftChoiceRow[];
  view: DraftView;
}

export function createDraftsService(deps: {
  db: Database;
  cache: Cache;
  logger: Logger;
  /** Клиент OpenDota: нужен только для списка героев Dota. */
  dotaClient?: FetchClient;
  /**
   * Клиент valorant-api: нужен только для списка агентов. Отдельный от Dota намеренно —
   * у каждого клиента свой предохранитель, и падение одного справочника не должно
   * закрывать второй.
   */
  valorantClient?: FetchClient;
  /** Клиент Enka.Network: нужен только для справочника персонажей Genshin. */
  enkaClient?: FetchClient;
  /** Клиент Data Dragon: нужен только для справочника чемпионов LoL. Ключа Riot не требует. */
  riotClient?: FetchClient;
  /**
   * Состав аккаунта Genshin из Летописи HoYoLAB. Необязательна: без неё драфт идёт без
   * пометок «есть на аккаунте», и это ровно то, что было до её появления.
   */
  chronicle?: {
    configured: boolean;
    roster(uid: string): Promise<{ ok: true; characters: { id: string }[] } | { ok: false }>;
  };
  /** UID Genshin участника. Отдаётся мостом к модулю личности, чтобы драфт не знал SQL. */
  genshinUidOf?: (entrantId: number) => Promise<string | null>;
}) {
  const { db, cache, logger } = deps;

  /**
   * Справочник в кэше на сутки. Отказ здесь не ошибка, а отсутствие фазы драфта: матч
   * сыграется без неё, как играл до сих пор. Ронять матч из-за недоступного справочника было
   * бы несоразмерно, поэтому наверх уходит `null`, а в лог — предупреждение.
   */
  async function catalog(
    client: FetchClient | undefined,
    key: string,
    what: string,
    load: (client: FetchClient) => Promise<DraftOption[]>,
  ): Promise<DraftOption[] | null> {
    if (!client) return null;
    try {
      const cached = await cache.swr<DraftOption[]>(key, {
        ttlMs: CATALOG_TTL_MS,
        staleMs: 7 * CATALOG_TTL_MS,
        load: () => load(client),
      });
      return cached.value.length > 0 ? cached.value : null;
    } catch (error) {
      logger.warn({ err: error }, `${what} недоступен — эта фаза драфта пройдена не будет`);
      return null;
    }
  }

  /**
   * Список героев Dota. Тянется из OpenDota, а не лежит константой: он меняется с патчем, и
   * захардкоженные сто двадцать семь имён устарели бы к первому же обновлению игры.
   */
  async function dotaHeroes(): Promise<DraftOption[] | null> {
    return catalog(deps.dotaClient, HERO_CACHE_KEY, 'список героев Dota', async (client) => {
      const heroes = await client.json<OpenDotaHero[]>(OPENDOTA_HEROES);
      return heroes
        .map((hero) => {
          const slug = hero.name.replace('npc_dota_hero_', '');
          return {
            id: slug,
            label: hero.localized_name,
            group: 'heroes' as const,
            imageUrl: `${HERO_IMAGE_BASE}/${slug}.png`,
            iconUrl: `${HERO_IMAGE_BASE}/icons/${slug}.png`,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    });
  }

  /**
   * Список агентов Valorant. Картинкой берётся портрет из килл-фида (9 КБ), а не крупная
   * иконка (400 КБ): агентов двадцать девять, и полотно драфта на крупных иконках весило бы
   * одиннадцать мегабайт. Килл-фид игрок и так видит каждый раунд, так что лицо узнаваемое.
   */
  async function valorantAgents(): Promise<DraftOption[] | null> {
    return catalog(deps.valorantClient, AGENT_CACHE_KEY, 'список агентов Valorant', async (client) => {
      const body = await client.json<{ data: ValorantAgent[] }>(VALORANT_AGENTS_URL);
      return body.data
        .map((agent) => ({
          id: agent.uuid,
          label: agent.displayName,
          group: 'agents' as const,
          ...(agent.killfeedPortrait ? { imageUrl: agent.killfeedPortrait } : {}),
          ...(agent.killfeedPortrait ? { iconUrl: agent.killfeedPortrait } : {}),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    });
  }

  /**
   * Список персонажей Genshin: сто одиннадцать имён с портретами, по-русски.
   *
   * Путешественник выброшен намеренно. Он есть на каждом аккаунте по определению, поэтому
   * банить его нечего — а элементных и половых вариантов у него шестнадцать, и все под двумя
   * именами, так что в пуле они выглядели бы как шестнадцать одинаковых плиток.
   *
   * Пробные копии (у одного персонажа встречается второй идентификатор с той же иконкой)
   * отбрасываются по имени файла иконки: одна плитка на персонажа, а не на строку в данных.
   */
  async function genshinCharacters(): Promise<DraftOption[] | null> {
    return catalog(deps.enkaClient, CHARACTER_CACHE_KEY, 'справочник персонажей Genshin', async (client) => {
      const [roster, locales] = await Promise.all([
        client.json<Record<string, EnkaCharacter>>(ENKA_CHARACTERS_URL),
        client.json<Record<string, Record<string, string>>>(ENKA_LOC_URL),
      ]);
      const names = locales.ru ?? locales.en ?? {};

      const seen = new Set<string>();
      const options: DraftOption[] = [];
      for (const [id, entry] of Object.entries(roster)) {
        const icon = entry.SideIconName;
        if (!icon) continue;
        if (icon.includes('PlayerBoy') || icon.includes('PlayerGirl')) continue;
        if (seen.has(icon)) continue;
        const label = names[String(entry.NameTextMapHash)];
        if (!label) continue;
        seen.add(icon);
        options.push({
          id,
          label,
          group: 'characters' as const,
          // Обе картинки — мелкая иконка, 128×128 и 14 КБ. Крупный портрет весит 76 КБ, и
          // на сто одиннадцать плиток это восемь мегабайт на один экран — ровно та же
          // причина, по которой у агентов Valorant взят портрет из килл-фида. Лицо на
          // мелкой иконке то же, а в самой игре ей и подписан отряд.
          imageUrl: `${GENSHIN_IMAGE_BASE}/${icon}.png`,
          iconUrl: `${GENSHIN_IMAGE_BASE}/${icon}.png`,
        });
      }
      return options.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    });
  }

  /**
   * Отмечает в пуле, у кого какой персонаж есть.
   *
   * Пул при этом остаётся общим и полным: пометка — сведения, а не запрет. Запрещать пик
   * персонажа, которого бот «не увидел», было бы хуже ошибки — Летопись обновляется с
   * задержкой, и вчерашняя крутка в ней ещё не появилась. Пусть игрок решает сам, зная.
   *
   * Идентификаторы сходятся сами: и справочник Enka, и Летопись называют персонажа одним и
   * тем же внутренним номером игры, потому что берут его из одних данных.
   */
  async function markOwnership(pool: DraftOption[], match: MatchRow): Promise<void> {
    const chronicle = deps.chronicle;
    const uidOf = deps.genshinUidOf;
    if (!chronicle?.configured || !uidOf) return;

    const sides: [DraftSide, number | null][] = [
      ['a', match.entrantAId],
      ['b', match.entrantBId],
    ];

    for (const [side, entrantId] of sides) {
      if (entrantId === null) continue;
      const uid = await uidOf(entrantId);
      if (!uid) continue;

      let result: Awaited<ReturnType<typeof chronicle.roster>>;
      try {
        result = await chronicle.roster(uid);
      } catch (error) {
        logger.warn({ err: error, uid }, 'состав аккаунта Genshin не прочитан — драфт пойдёт без пометок');
        continue;
      }
      if (!result.ok) continue;

      const owned = new Set(result.characters.map((character) => character.id));
      for (const option of pool) {
        if (!owned.has(option.id)) continue;
        option.owned = [...(option.owned ?? []), side];
      }
    }
  }

  /**
   * Список чемпионов League of Legends: больше двух сотен, по-русски, с квадратными иконками.
   *
   * Иконка 128×128 и 27 КБ — та же, что игра рисует в отборе чемпионов, поэтому лицо
   * узнаваемое. Крупный портрет загрузки весит вдвое больше, а на две сотни плиток разница
   * складывается в лишние шесть мегабайт.
   */
  async function lolChampions(): Promise<DraftOption[] | null> {
    return catalog(deps.riotClient, CHAMPION_CACHE_KEY, 'справочник чемпионов LoL', async (client) => {
      const versions = await client.json<string[]>(DDRAGON_VERSIONS);
      const version = versions[0];
      if (!version) return [];

      const body = await client.json<DataDragonChampions>(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/ru_RU/champion.json`,
      );
      const art = `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion`;

      return Object.values(body.data)
        .map((champion) => ({
          id: champion.id,
          label: champion.name,
          group: 'champions' as const,
          imageUrl: `${art}/${champion.id}.png`,
          iconUrl: `${art}/${champion.id}.png`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    });
  }

  async function choicesOf(draftId: number): Promise<DraftChoiceRow[]> {
    return db
      .select()
      .from(draftChoices)
      .where(eq(draftChoices.draftId, draftId))
      .orderBy(asc(draftChoices.step));
  }

  function viewOf(draft: MatchDraftRow, rows: DraftChoiceRow[]): DraftView {
    const choices: DraftChoice[] = rows.map((row) => ({
      step: row.step,
      side: row.side,
      kind: row.kind,
      optionId: row.optionId,
    }));
    // `subject` — набор для шагов без пометки: так читаются драфты, заведённые до фаз.
    return draftView(draft.pool, draft.sequence as DraftStep[], choices, draft.subject);
  }

  async function stateOf(draft: MatchDraftRow): Promise<DraftState> {
    const rows = await choicesOf(draft.id);
    return { draft, choices: rows, view: viewOf(draft, rows) };
  }

  /** Завершает драфт, когда шаги кончились. Идемпотентно: условие в WHERE. */
  async function completeIfDone(draft: MatchDraftRow, view: DraftView): Promise<void> {
    if (!view.done) return;
    await db
      .update(matchDrafts)
      .set({ completedAt: new Date(), deadlineAt: null })
      .where(and(eq(matchDrafts.id, draft.id), isNull(matchDrafts.completedAt)));
  }

  return {
    /**
     * Создаёт драфт для матча. Идемпотентно: один матч — один драфт, второй вернёт
     * существующий, потому что комнаты матчей пересоздаются повторными вызовами.
     *
     * `null` означает «драфт этой дисциплине не нужен или справочник недоступен» — это
     * штатный исход, а не сбой.
     */
    async ensureForMatch(
      tournament: TournamentRow,
      match: MatchRow,
    ): Promise<{ draft: MatchDraftRow; created: boolean } | null> {
      const [existing] = await db.select().from(matchDrafts).where(eq(matchDrafts.matchId, match.id));
      if (existing) return { draft: existing, created: false };

      // Способности выключены — делить нечего: дуэль на прицел играется на любом агенте, и
      // ни агенты, ни карта на неё не влияют. Драфта у такого турнира нет вовсе.
      if (!tournament.abilities) return null;

      const subject = draftSubject(tournament.game);
      if (subject === null) return null;
      if (match.entrantAId === null || match.entrantBId === null) return null;

      // Пиков столько, сколько нужно стороне: по одному на игрока у героев и агентов, восемь
      // у персонажей Genshin (этаж Бездны — две половины по четыре). Пока это не считалось,
      // турнир один на один выдавал игроку драфт на пятерых героев, то есть четырёх лишних.
      const picksPerSide = picksFor(subject === 'maps' ? 'agents' : subject, tournament.teamSize);
      const bansPerSide = bansFor(picksPerSide, subject === 'maps' ? 'agents' : subject);

      const pool: DraftOption[] = [];
      const sequence: DraftStep[] = [];

      if (subject === 'maps') {
        pool.push(...VALORANT_MAPS);
        sequence.push(...mapVetoSequence(VALORANT_MAPS.length, tournament.bestOf));

        // Вторая фаза — агенты. Правило сервера, а не Riot: в самой игре агентов не делят.
        // Справочник недоступен — матч пройдёт с одним вето карт, и это лучше, чем не дать
        // капитанам поделить хотя бы карты.
        const agents = await valorantAgents();
        const agentSteps = pickBanSequence('agents', picksPerSide, bansPerSide);
        if (agents && poolFits(agents.length, agentSteps, 'agents')) {
          pool.push(...agents);
          sequence.push(...agentSteps);
        }
      } else {
        const options =
          subject === 'characters'
            ? await genshinCharacters()
            : subject === 'champions'
              ? await lolChampions()
              : await dotaHeroes();
        if (!options) return null;
        const steps = pickBanSequence(subject, picksPerSide, bansPerSide);
        if (!poolFits(options.length, steps, subject)) return null;
        pool.push(...options);
        sequence.push(...steps);
      }

      if (pool.length < 2 || sequence.length === 0) return null;

      // Пометки ставятся до записи: пул уходит в базу снимком на момент матча, и потом
      // страница драфта не зависит ни от HoYoLAB, ни от того, что игрок успел накрутить
      // после начала. Летопись, прочитанная во время матча, — это и есть протокол.
      if (subject === 'characters') await markOwnership(pool, match);

      const [created] = await db
        .insert(matchDrafts)
        .values({
          matchId: match.id,
          tournamentId: tournament.id,
          subject,
          pool,
          sequence,
          tokenA: randomBytes(16).toString('hex'),
          tokenB: randomBytes(16).toString('hex'),
          deadlineAt: new Date(Date.now() + STEP_TIMEOUT_MS),
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { draft: created, created: true };

      // Вставку занял конкурентный вызов — перечитываем. Признак «создан» при этом ложный:
      // ссылки капитанам разошлёт тот вызов, который действительно вставил строку.
      const [again] = await db.select().from(matchDrafts).where(eq(matchDrafts.matchId, match.id));
      return again ? { draft: again, created: false } : null;
    },

    /** Матчи, которые уже можно играть, но драфта у них ещё нет. */
    async matchesNeedingDraft(tournamentId: number): Promise<MatchRow[]> {
      const rows = await db
        .select({ match: tournamentMatches, draftId: matchDrafts.id })
        .from(tournamentMatches)
        .leftJoin(matchDrafts, eq(matchDrafts.matchId, tournamentMatches.id))
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            eq(tournamentMatches.state, 'ready'),
            isNull(matchDrafts.id),
            sql`${tournamentMatches.entrantAId} is not null`,
            sql`${tournamentMatches.entrantBId} is not null`,
          ),
        );
      return rows.map((row) => row.match);
    },

    async byMatch(matchId: number): Promise<MatchDraftRow | null> {
      const [row] = await db.select().from(matchDrafts).where(eq(matchDrafts.matchId, matchId));
      return row ?? null;
    },

    async byId(draftId: number): Promise<MatchDraftRow | null> {
      const [row] = await db.select().from(matchDrafts).where(eq(matchDrafts.id, draftId));
      return row ?? null;
    },

    /** Сторона, за которую даёт действовать этот токен. Пустой токен — только смотреть. */
    sideOfToken(draft: MatchDraftRow, token: string | undefined): DraftSide | null {
      if (!token) return null;
      if (token === draft.tokenA) return 'a';
      if (token === draft.tokenB) return 'b';
      return null;
    },

    state: stateOf,

    /**
     * Делает выбор. От гонки защищает уникальность `(draftId, step)`: два одновременных
     * нажатия вычислят один номер шага, но вставка удастся одному — второй получит внятный
     * отказ вместо перезаписи чужого хода.
     */
    async choose(
      draftId: number,
      side: DraftSide,
      optionId: string | null,
      actorId: string | null,
    ): Promise<DraftState> {
      const draft = await this.byId(draftId);
      if (!draft) throw new UserError('Драфт не найден.');

      const before = await stateOf(draft);
      const verdict = canChoose(before.view, side, optionId);
      if (!verdict.ok) throw new UserError(verdict.reason);

      const step = before.view.current;
      if (!step) throw new UserError('Драфт уже закончен.');

      const [inserted] = await db
        .insert(draftChoices)
        .values({
          draftId,
          step: before.view.step,
          side,
          kind: step.kind,
          optionId,
          actorId,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        throw new UserError('Этот ход уже сделан — обнови страницу.');
      }

      const after = await stateOf(draft);
      await completeIfDone(draft, after.view);

      if (!after.view.done) {
        await db
          .update(matchDrafts)
          .set({ deadlineAt: new Date(Date.now() + STEP_TIMEOUT_MS) })
          .where(eq(matchDrafts.id, draftId));
      }

      return stateOf((await this.byId(draftId)) ?? draft);
    },

    /** Драфты, где время хода вышло. */
    async overdue(now: Date, limit: number): Promise<MatchDraftRow[]> {
      return db
        .select()
        .from(matchDrafts)
        .where(
          and(
            isNull(matchDrafts.completedAt),
            or(isNull(matchDrafts.deadlineAt), lt(matchDrafts.deadlineAt, now)),
          ),
        )
        .orderBy(asc(matchDrafts.deadlineAt))
        .limit(limit);
    },

    /**
     * Двигает просроченный драфт: бан пропускается, пик берётся первым свободным. Без этого
     * закрытый браузер одного капитана останавливал бы матч навсегда — та же болезнь, что у
     * матча без заявленного результата, и лечится так же.
     */
    async advanceOverdue(draft: MatchDraftRow): Promise<DraftState> {
      const before = await stateOf(draft);
      if (before.view.done) {
        await completeIfDone(draft, before.view);
        return before;
      }

      const side = before.view.current?.side;
      if (!side) return before;

      return this.choose(draft.id, side, autoChoice(before.view), null);
    },
  };
}

export type DraftsService = ReturnType<typeof createDraftsService>;
