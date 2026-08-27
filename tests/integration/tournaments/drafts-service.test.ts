import { describe, expect, it } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import { loadConfig } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { FetchClient } from '../../../src/core/http/fetch-client.js';
import { VALORANT_MAPS } from '../../../src/modules/tournaments/draft/pools.js';
import type { MatchRow, TournamentRow } from '../../../src/modules/tournaments/schema.js';
import { createDraftsService } from '../../../src/modules/tournaments/services/drafts.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { genshinUidOfEntrant } from '../../../src/modules/tournaments/services/strength.js';
import { withPostgres } from '../../helpers/postgres.js';
import { withRedis } from '../../helpers/redis.js';

const pg = withPostgres();
const redis = withRedis();

/**
 * Заведение драфта. Проверяется против настоящего Postgres, потому что защита «один матч —
 * один драфт» стоит на уникальности в базе, а не на проверке перед записью.
 *
 * Справочники подменяются заглушкой: тест про то, какие фазы получаются у формата, а не про
 * доступность чужого API. Ходить в сеть из набора тестов значило бы ронять его тогда, когда
 * лежит OpenDota.
 */

let counter = 0;

/** Заглушка справочника: отдаёт ровно то, что просят, без сети. */
function catalogClient(payload: unknown): FetchClient {
  return { json: async <T>(): Promise<T> => payload as T };
}

/**
 * Заглушка Enka: справочник персонажей собирается из двух файлов — игровые данные и словарь
 * локализаций, — поэтому одного ответа тут мало и подмена смотрит на адрес.
 */
function enkaCatalogClient(roster: unknown, locales: unknown): FetchClient {
  return { json: async <T>(url: string): Promise<T> => (url.includes('loc.json') ? locales : roster) as T };
}

/**
 * Выгрузка Enka в миниатюре: двадцать обычных персонажей, оба Путешественника и пробная
 * копия. Форма та же, что у настоящей, включая имена хэшами — они и есть причина, по которой
 * справочник тянется двумя файлами.
 */
const genshinRoster: Record<string, Record<string, unknown>> = {
  ...Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      String(10000100 + index),
      { NameTextMapHash: 900 + index, SideIconName: `UI_AvatarIcon_Side_Hero${index}`, Element: 'Fire' },
    ]),
  ),
  // Пробная копия: другой идентификатор, та же иконка. В пуле ей место одно, а не два.
  '10000903': { NameTextMapHash: 900, SideIconName: 'UI_AvatarIcon_Side_Hero0', Element: 'Fire' },
  // Путешественник: шестнадцать вариантов под двумя именами. Ни одному в пуле не место.
  '10000005': { NameTextMapHash: 800, SideIconName: 'UI_AvatarIcon_Side_PlayerBoy', Element: 'Wind' },
  '10000005-502': { NameTextMapHash: 800, SideIconName: 'UI_AvatarIcon_Side_PlayerBoy', Element: 'Fire' },
  '10000007': { NameTextMapHash: 801, SideIconName: 'UI_AvatarIcon_Side_PlayerGirl', Element: 'Wind' },
  // Строка без иконки: в настоящей выгрузке такие есть, и картинки для них не существует.
  '10000098': { NameTextMapHash: 802 },
  // Пробная копия вышедшего персонажа: своя запись, своя иконка, но в игре это тот же герой.
  '10000901': { NameTextMapHash: 803, SideIconName: 'UI_AvatarIcon_Side_Trial', Element: 'Fire' },
  // Невышедший персонаж: есть только в пробном диапазоне, и нет ни у кого.
  '10000904': { NameTextMapHash: 804, SideIconName: 'UI_AvatarIcon_Side_Unreleased', Element: 'Ice' },
  // Служебная запись с чужой иконкой: без отсечки могла вытеснить настоящего персонажа.
  '11000046': { NameTextMapHash: 805, SideIconName: 'UI_AvatarIcon_Side_Hero1', Element: 'Fire' },
};

/**
 * Data Dragon в миниатюре. Форма та же, включая то, ради чего справочник тянется двумя
 * запросами: путь к картинкам прибит к версии патча, и версию сначала надо узнать.
 */
const ddragonVersions = ['16.15.1', '16.14.1'];
const ddragonChampions = {
  data: Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [
      `Champ${index}`,
      { id: `Champ${index}`, name: `Чемпион ${String(index).padStart(2, '0')}` },
    ]),
  ),
};

function ddragonClient(): FetchClient {
  return {
    json: async <T>(url: string): Promise<T> =>
      (url.includes('versions.json') ? ddragonVersions : ddragonChampions) as T,
  };
}

const genshinLocales = {
  ru: {
    ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(900 + index), `Персонаж ${index}`])),
    '800': 'Путешественник',
    '801': 'Путешественница',
    '802': 'Без иконки',
    '803': 'Пробная копия',
    '804': 'Невышедший',
    '805': 'Служебная запись',
  },
};

const agents = {
  data: Array.from({ length: 20 }, (_, index) => ({
    uuid: `agent-${index}`,
    displayName: `Агент ${index}`,
    killfeedPortrait: `https://media.valorant-api.com/agents/agent-${index}/killfeedportrait.png`,
    displayIcon: null,
  })),
};

const heroes = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1,
  name: `npc_dota_hero_hero${index}`,
  localized_name: `Герой ${index}`,
}));

async function makeMatch(options: {
  game: 'dota2' | 'valorant' | 'genshin' | 'lol';
  solo: boolean;
  abilities?: boolean;
  /** UID Genshin, привязанный и подтверждённый у участника этой стороны. */
  genshinUids?: Partial<Record<'a' | 'b', string>>;
}): Promise<{ tournament: TournamentRow; match: MatchRow }> {
  counter += 1;
  const service = createTournamentsService({ db: pg.db });
  const guildId = `62000000000000${String(counter).padStart(4, '0')}`;

  const tournament = await service.create({
    guildId,
    name: `Турнир ${counter}`,
    game: options.game,
    format: 'single-elim',
    entryMode: options.solo ? 'solo' : 'team',
    teamSize: options.solo ? 1 : 5,
    maxEntrants: 8,
    seeding: 'rank',
    bestOf: 1,
    ...(options.abilities === undefined ? {} : { abilities: options.abilities }),
    requireVerified: false,
    createdBy: 'organizer',
  });
  await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));

  const ids: number[] = [];
  const linking = createLinkingService({ db: pg.db });
  for (let index = 0; index < 2; index += 1) {
    const user = `9${String(counter).padStart(8, '0')}${String(index).padStart(8, '0')}`;
    const entrant = await service.createEntrant(tournament.id, user, `Состав ${index + 1}`);
    await service.checkIn(tournament.id, user);
    ids.push(entrant.id);

    // Привязка нужна подтверждённой: без подтверждения любой указал бы чужой UID и играл
    // «по его составу», и мост её намеренно не видит.
    const uid = options.genshinUids?.[index === 0 ? 'a' : 'b'];
    if (uid) {
      await linking.ensureUser(user);
      await linking.linkAccount(
        user,
        'enka',
        { externalId: uid, displayName: `Игрок ${uid}`, verificationMethod: 'genshin-signature' },
        true,
      );
    }
  }
  const view = await service.start(tournament.id, new Map(ids.map((id, index) => [id, 1_000 - index])));

  const match = view.matches.find((row) => row.state === 'ready');
  if (!match) throw new Error('матч не построился');
  return { tournament: await service.byId(tournament.id), match };
}

/**
 * Настоящий Redis, а не заглушка: справочники ходят через `cache.swr`, и на подделке кэша
 * тест проверял бы не тот путь, которым пул попадает в драфт в бою.
 */
function drafts(options?: {
  chronicle?: Parameters<typeof createDraftsService>[0]['chronicle'];
  /** Заявленный состав: тот же для любого участника — тестам большего не нужно. */
  declared?: Record<string, { id: string; constellation: number; cost: number }>;
}) {
  const config = loadConfig({
    DISCORD_TOKEN: 'test',
    DISCORD_APP_ID: '123456789012345678',
    DISCORD_GUILD_ID: '876543210987654321',
    DATABASE_URL: 'postgres://localhost:5432/x',
    REDIS_URL: redis.url,
    PUBLIC_BASE_URL: 'https://test.example.com',
    NODE_ENV: 'test',
  });
  const logger = createLogger(config);
  const cache = new Cache(config, logger);
  return {
    service: createDraftsService({
      db: pg.db,
      cache,
      logger,
      dotaClient: catalogClient(heroes),
      valorantClient: catalogClient(agents),
      enkaClient: enkaCatalogClient(genshinRoster, genshinLocales),
      riotClient: ddragonClient(),
      ...(options?.chronicle ? { chronicle: options.chronicle, genshinUidOf } : {}),
      ...(options?.declared
        ? { declaredOf: async () => Object.values(options.declared ?? {}) }
        : {}),
    }),
    cache,
  };
}

const genshinUidOf = (entrantId: number): Promise<string | null> => genshinUidOfEntrant(pg.db, entrantId);

/**
 * Летопись-заглушка: отдаёт заданный состав по UID, ничего не зная про сеть. Персонажи
 * лимитированные пятизвёздочные C0 — то есть по одному очку каждый, если не сказано иначе.
 */
function chronicleWith(
  byUid: Record<string, (string | { id: string; constellation?: number; rarity?: number })[]>,
): Parameters<typeof createDraftsService>[0]['chronicle'] {
  return {
    configured: true,
    roster: async (uid: string) => {
      const entries = byUid[uid];
      if (!entries) return { ok: false };
      return {
        ok: true,
        characters: entries.map((entry) => {
          const raw = typeof entry === 'string' ? { id: entry } : entry;
          return {
            id: raw.id,
            name: `Персонаж ${raw.id}`,
            rarity: raw.rarity ?? 5,
            constellation: raw.constellation ?? 0,
            sets: [],
          };
        }),
      };
    },
  };
}

/**
 * Пометки «есть на аккаунте». Смысл в том, чтобы бан не уходил в пустоту: банить персонажа,
 * которого у соперника и не было, — потраченный ход, и видеть это надо до хода.
 */
describe('драфт чемпионов LoL', () => {
  it('пиков по числу игроков в команде, банов два на сторону', async () => {
    const { tournament, match } = await makeMatch({ game: 'lol', solo: false });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const steps = created?.draft.sequence ?? [];
    expect(created?.draft.subject).toBe('champions');
    expect(steps.every((step) => step.group === 'champions')).toBe(true);
    expect(steps.filter((step) => step.kind === 'ban')).toHaveLength(4);
    expect(steps.filter((step) => step.kind === 'pick' && step.side === 'a')).toHaveLength(5);
  });

  /** Путь к картинке прибит к версии патча — поэтому её и спрашивают, а не хардкодят. */
  it('картинки берутся из текущей версии Data Dragon', async () => {
    const { tournament, match } = await makeMatch({ game: 'lol', solo: false });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const first = (created?.draft.pool ?? [])[0];
    expect(first?.imageUrl).toContain('/cdn/16.15.1/img/champion/');
    expect(first?.imageUrl).toBe(first?.iconUrl);
  });

  it('имена идут по алфавиту', async () => {
    const { tournament, match } = await makeMatch({ game: 'lol', solo: false });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const labels = (created?.draft.pool ?? []).map((option) => option.label);
    expect(labels).toHaveLength(30);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'ru')));
  });
});

describe('состав аккаунта в пуле драфта', () => {
  it('помечает, у кого какой персонаж есть', async () => {
    const { tournament, match } = await makeMatch({
      game: 'genshin',
      solo: true,
      genshinUids: { a: '700000001', b: '700000002' },
    });
    const { service, cache } = drafts({
      chronicle: chronicleWith({
        '700000001': ['10000100', '10000101'],
        '700000002': ['10000101', '10000102'],
      }),
    });

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const pool = created?.draft.pool ?? [];
    const owned = (id: string): string[] | undefined => pool.find((option) => option.id === id)?.owned;
    expect(owned('10000100')).toEqual(['a']);
    expect(owned('10000101')).toEqual(['a', 'b']);
    expect(owned('10000102')).toEqual(['b']);
    // Ни у кого — это пустой список, а не отсутствие пометки: про этого персонажа известно.
    expect(owned('10000103')).toBeUndefined();
  });

  /**
   * Отсутствие пометок означает «неизвестно». Оно и должно быть неотличимо от того, как драфт
   * работал до Летописи: закрытая Летопись не повод останавливать матч.
   */
  /**
   * Стоимость считается на момент создания драфта и ложится в снимок пула вместе с ним.
   * Пересчитывать её при показе страницы было бы неверно: аккаунт назавтра изменится, а
   * сыгранный матч должен остаться сыгранным по тем числам, по которым его играли.
   */
  it('запоминает созвездие и цену каждой стороны', async () => {
    const { tournament, match } = await makeMatch({
      game: 'genshin',
      solo: true,
      genshinUids: { a: '700000041', b: '700000042' },
    });
    const { service, cache } = drafts({
      chronicle: chronicleWith({
        // Лимитированный C2 стоит 3 очка, C0 — одно. Четырёхзвёздочный бесплатен.
        '700000041': [{ id: '10000100', constellation: 2 }, { id: '10000101', rarity: 4, constellation: 6 }],
        '700000042': [{ id: '10000100', constellation: 0 }],
      }),
    });

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const pool = created?.draft.pool ?? [];
    const builds = pool.find((option) => option.id === '10000100')?.builds ?? [];
    expect(builds.find((build) => build.side === 'a')).toMatchObject({ constellation: 2, cost: 3 });
    expect(builds.find((build) => build.side === 'b')).toMatchObject({ constellation: 0, cost: 1 });

    const free = pool.find((option) => option.id === '10000101')?.builds ?? [];
    expect(free[0]).toMatchObject({ side: 'a', cost: 0 });
  });

  /**
   * Заявка старше Летописи и главнее её: игрок мог выкрутить созвездие после того, как
   * заявился, а матч обязан идти по тому, с чем он пришёл.
   */
  it('заявленный состав главнее того, что сейчас в Летописи', async () => {
    const { tournament, match } = await makeMatch({
      game: 'genshin',
      solo: true,
      genshinUids: { a: '700000051' },
    });
    const { service, cache } = drafts({
      // В Летописи сейчас C6 — то есть 7 очков.
      chronicle: chronicleWith({ '700000051': [{ id: '10000100', constellation: 6 }] }),
      // А заявлялся он с C0 за одно очко, и матч должен идти по заявке.
      declared: {
        '10000100': { id: '10000100', constellation: 0, cost: 1 },
      },
    });

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const builds = (created?.draft.pool ?? []).find((option) => option.id === '10000100')?.builds ?? [];
    expect(builds.find((build) => build.side === 'a')).toMatchObject({ constellation: 0, cost: 1 });
  });

  it('без заявки читается Летопись — она запасной путь, а не отменённый', async () => {
    const { tournament, match } = await makeMatch({
      game: 'genshin',
      solo: true,
      genshinUids: { a: '700000052' },
    });
    const { service, cache } = drafts({
      chronicle: chronicleWith({ '700000052': [{ id: '10000100', constellation: 2 }] }),
    });

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const builds = (created?.draft.pool ?? []).find((option) => option.id === '10000100')?.builds ?? [];
    expect(builds.find((build) => build.side === 'a')).toMatchObject({ constellation: 2, cost: 3 });
  });

  it('закрытая Летопись оставляет пул без пометок', async () => {
    const { tournament, match } = await makeMatch({
      game: 'genshin',
      solo: true,
      genshinUids: { a: '700000011' },
    });
    const { service, cache } = drafts({ chronicle: chronicleWith({}) });

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    expect((created?.draft.pool ?? []).every((option) => option.owned === undefined)).toBe(true);
  });

  it('без Летописи вовсе пул тот же, что был', async () => {
    const { tournament, match } = await makeMatch({
      game: 'genshin',
      solo: true,
      genshinUids: { a: '700000021' },
    });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    expect((created?.draft.pool ?? []).every((option) => option.owned === undefined)).toBe(true);
  });

  it('без подтверждённой привязки состав не читается: чужой UID играл бы за своего', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts({ chronicle: chronicleWith({ '700000031': ['10000100'] }) });

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    expect((created?.draft.pool ?? []).every((option) => option.owned === undefined)).toBe(true);
  });
});

describe('драфт персонажей Genshin', () => {
  /**
   * Пиков восемь, а не по одному на участника: этаж Бездны проходят двумя половинами по
   * четыре, и четвёрка означала бы, что во вторую половину игрок выходит без команды.
   */
  it('восемь пиков на сторону и по три бана, сколько бы ни было участников', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const steps = created?.draft.sequence ?? [];
    expect(created?.draft.subject).toBe('characters');
    expect(steps.every((step) => step.group === 'characters')).toBe(true);
    expect(steps.filter((step) => step.kind === 'ban')).toHaveLength(6);
    expect(steps.filter((step) => step.kind === 'pick' && step.side === 'a')).toHaveLength(8);
    expect(steps.filter((step) => step.kind === 'pick' && step.side === 'b')).toHaveLength(8);
  });

  it('в пул попадают только настоящие персонажи: без Путешественника, без пробных копий, по одному разу', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const pool = created?.draft.pool ?? [];
    expect(pool).toHaveLength(20);
    expect(pool.map((option) => option.label)).not.toContain('Путешественник');
    expect(pool.map((option) => option.label)).not.toContain('Путешественница');
    expect(pool.map((option) => option.label)).not.toContain('Без иконки');
    expect(new Set(pool.map((option) => option.id)).size).toBe(pool.length);
  });

  /**
   * Обе картинки — мелкая иконка. Крупный портрет весит 76 КБ против 14, и на сто с лишним
   * плиток это восемь мегабайт на один экран.
   */
  it('картинкой берётся мелкая иконка, а не крупный портрет', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const first = (created?.draft.pool ?? []).find((option) => option.label === 'Персонаж 0');
    expect(first?.imageUrl).toBe('https://enka.network/ui/UI_AvatarIcon_Side_Hero0.png');
    expect(first?.iconUrl).toBe('https://enka.network/ui/UI_AvatarIcon_Side_Hero0.png');
  });

  /**
   * В выгрузке Enka рядом с настоящими персонажами лежат пробные копии, невышедшие и служебные
   * записи. Первых нет ни у кого, вторых нет в игре вовсе, а третья носит чужую иконку и без
   * отсечки могла вытеснить настоящего персонажа — победил бы тот, кто раньше в чужом JSON.
   */
  it('пробные, невышедшие и служебные записи в пул не попадают', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const labels = (created?.draft.pool ?? []).map((option) => option.label);
    expect(labels).not.toContain('Пробная копия');
    expect(labels).not.toContain('Невышедший');
    expect(labels).not.toContain('Служебная запись');
    // Настоящий персонаж с той же иконкой, что у служебной записи, остался на месте.
    expect(labels).toContain('Персонаж 1');
  });

  it('имена идут по алфавиту, а не в порядке выгрузки', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const labels = (created?.draft.pool ?? []).map((option) => option.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'ru')));
  });
});

describe('какие фазы получает драфт', () => {
  it('Valorant 5×5 — карты, потом агенты', async () => {
    const { tournament, match } = await makeMatch({ game: 'valorant', solo: false });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const groups = created?.draft.sequence.map((step) => step.group) ?? [];
    expect(new Set(groups)).toEqual(new Set(['maps', 'agents']));
    // Шесть банов карт плюс четыре бана и десять пиков агентов.
    expect(created?.draft.sequence).toHaveLength(VALORANT_MAPS.length - 1 + 14);
  });

  it('Valorant 1×1 со способностями — карты и по одному агенту', async () => {
    const { tournament, match } = await makeMatch({ game: 'valorant', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const agentSteps = created?.draft.sequence.filter((step) => step.group === 'agents') ?? [];
    // По одному бану и одному пику на сторону: пятеро агентов одному игроку не нужны.
    expect(agentSteps).toHaveLength(4);
    expect(agentSteps.filter((step) => step.kind === 'pick')).toHaveLength(2);
  });

  /**
   * Дуэль на прицел. Способности выключены — значит ни агенты, ни карта на исход не влияют, и
   * драфта нет вовсе. Обещать вето там, где выбор ничего не решает, значило бы заставлять
   * капитанов нажимать кнопки без причины.
   */
  it('без способностей драфта нет вовсе', async () => {
    const { tournament, match } = await makeMatch({ game: 'valorant', solo: true, abilities: false });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    expect(created).toBeNull();
  });

  it('Dota 1×1 — только герои, по одному на сторону', async () => {
    const { tournament, match } = await makeMatch({ game: 'dota2', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const groups = new Set(created?.draft.sequence.map((step) => step.group));
    expect(groups).toEqual(new Set(['heroes']));
    expect(created?.draft.sequence.filter((step) => step.kind === 'pick')).toHaveLength(2);
  });

  it('один матч — один драфт, второй вызов возвращает тот же', async () => {
    const { tournament, match } = await makeMatch({ game: 'valorant', solo: false });
    const { service, cache } = drafts();

    const first = await service.ensureForMatch(tournament, match);
    const second = await service.ensureForMatch(tournament, match);
    await cache.close();

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.draft.id).toBe(first?.draft.id);
  });
});
