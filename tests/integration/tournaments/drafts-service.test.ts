import { describe, expect, it } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import { loadConfig } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { FetchClient } from '../../../src/core/http/fetch-client.js';
import { VALORANT_MAPS } from '../../../src/modules/tournaments/draft/pools.js';
import type { MatchRow, TournamentRow } from '../../../src/modules/tournaments/schema.js';
import { createDraftsService } from '../../../src/modules/tournaments/services/drafts.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
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
};

const genshinLocales = {
  ru: {
    ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(900 + index), `Персонаж ${index}`])),
    '800': 'Путешественник',
    '801': 'Путешественница',
    '802': 'Без иконки',
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
  game: 'dota2' | 'valorant' | 'genshin';
  solo: boolean;
  abilities?: boolean;
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
  for (let index = 0; index < 2; index += 1) {
    const user = `9${String(counter).padStart(8, '0')}${String(index).padStart(8, '0')}`;
    const entrant = await service.createEntrant(tournament.id, user, `Состав ${index + 1}`);
    await service.checkIn(tournament.id, user);
    ids.push(entrant.id);
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
function drafts() {
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
    }),
    cache,
  };
}

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

  it('портрет и мелкая иконка — разные картинки одного персонажа', async () => {
    const { tournament, match } = await makeMatch({ game: 'genshin', solo: true });
    const { service, cache } = drafts();

    const created = await service.ensureForMatch(tournament, match);
    await cache.close();

    const first = (created?.draft.pool ?? []).find((option) => option.label === 'Персонаж 0');
    expect(first?.imageUrl).toBe('https://enka.network/ui/UI_AvatarIcon_Hero0.png');
    expect(first?.iconUrl).toBe('https://enka.network/ui/UI_AvatarIcon_Side_Hero0.png');
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
