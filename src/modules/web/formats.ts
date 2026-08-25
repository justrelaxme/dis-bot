import type { FastifyInstance } from 'fastify';
import type { Database } from '../../core/db/client.js';
import { describeForUser } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { TOURNAMENT_GAMES, TOURNAMENT_GAME_LABELS } from '../tournaments/games.js';
import type { EntryMode, SeedingMode, TournamentFormat, TournamentGame } from '../tournaments/schema.js';
import type { TournamentFormatRow } from '../tournaments/schema.js';
import {
  MAX_FORMATS_PER_GUILD,
  bricksOf,
  createFormatsService,
  normalizeBricks,
  previewOf,
  type FormatBricks,
} from '../tournaments/services/formats.js';
import { createGrantsService } from './grants.js';
import {
  FORMATS_STYLE,
  formatCardsHtml,
  formatsDenied,
  formatsShell,
  type FormatCard,
} from './formats-page.js';
import { page } from './render.js';

/**
 * Конструктор форматов: страница и её три действия — предпросмотр, сохранение, удаление.
 *
 * Устройство доступа описано в `schema.ts`: право даёт токен в адресе, потому что витрина
 * анонимна по устройству. Здесь важно другое следствие того же решения — **область пропуска
 * задаёт и сервер**. Токен приносит с собой guildId, и все запросы к базе фильтруются по
 * нему, а не по тому, что пришло в теле запроса. Иначе достаточный для своего сервера
 * пропуск позволял бы править форматы чужого, просто подставив другой идентификатор.
 */

export interface FormatRoutesDeps {
  db: Database;
  logger: Logger;
}

/** Что пришло из браузера. Ничему тут не верим: приводим и проверяем на сервере. */
interface RawBricks {
  game?: unknown;
  entryMode?: unknown;
  teamSize?: unknown;
  maxEntrants?: unknown;
  format?: unknown;
  bestOf?: unknown;
  seeding?: unknown;
  abilities?: unknown;
  autoTeams?: unknown;
  requireVerified?: unknown;
  registrationHours?: unknown;
  costCap?: unknown;
}

const GAMES = new Set<string>(TOURNAMENT_GAMES);

function asGame(value: unknown): TournamentGame | null {
  return typeof value === 'string' && GAMES.has(value) ? (value as TournamentGame) : null;
}

function asInt(value: unknown, fallback: number): number {
  // Отсутствие значения проверяется до `Number`, а не после: `Number(null)` и `Number('')`
  // дают нуль, а не «не число», и поле, которого в запросе нет, превращалось бы в нуль вместо
  // значения по умолчанию. У `bestOf` это означало «карт в матче ноль» и отказ вместо
  // предпросмотра — то есть страница выглядела бы сломанной из-за пропущенного поля.
  if (value === null || value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * Разбор присланного набора. Неизвестные значения заменяются значением по умолчанию, а не
 * отвергаются: страница и сервер могут разойтись на одну версию — при обновлении бота у
 * кого-то открыта старая вкладка, — и падать из-за этого незачем. А вот числа и границы
 * проверяет `normalizeBricks`, потому что это уже правила турнира, а не разбор запроса.
 */
function readBricks(raw: RawBricks | undefined): FormatBricks {
  const body = raw ?? {};
  const entryMode: EntryMode = body.entryMode === 'solo' ? 'solo' : 'team';
  const format: TournamentFormat = body.format === 'double-elim' ? 'double-elim' : 'single-elim';
  const seeding: SeedingMode = body.seeding === 'random' ? 'random' : 'rank';

  return {
    game: asGame(body.game),
    entryMode,
    teamSize: asInt(body.teamSize, entryMode === 'solo' ? 1 : 5),
    maxEntrants: asInt(body.maxEntrants, 16),
    format,
    bestOf: asInt(body.bestOf, 1),
    seeding,
    abilities: body.abilities !== false,
    autoTeams: body.autoTeams === true,
    requireVerified: body.requireVerified !== false,
    registrationHours: asInt(body.registrationHours, 2),
    // Пустое поле означает «без потолка», а не ноль: ноль — это законный и очень жёсткий
    // бюджет, при котором проходят только четырёхзвёздочные составы.
    costCap: asCap(body.costCap),
  };
}

/** Потолок стоимости: пустое поле — «без потолка», всё остальное — число с половинками. */
function asCap(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Карточка формата для страницы: то же самое, что видно в списке, плюс настройки для правки. */
function cardOf(row: TournamentFormatRow): FormatCard {
  const preview = previewOf(bricksOf(row));
  return {
    id: row.id,
    name: row.name,
    summary: preview.headline,
    note: row.note,
    usedCount: row.usedCount,
    bricks: {
      ...bricksOf(row),
      // Страница держит «любую дисциплину» пустой строкой: в HTML нет способа выбрать null.
      game: row.game ?? '',
    },
  };
}

export function registerFormatRoutes(server: FastifyInstance, deps: FormatRoutesDeps): void {
  const formats = createFormatsService({ db: deps.db });
  const grants = createGrantsService({ db: deps.db });

  /** Карточки в трёх видах сразу: данные для скрипта, готовая разметка и предел. */
  async function cardsPayload(guildId: string): Promise<{
    data: FormatCard[];
    html: string;
    limit: number;
  }> {
    const rows = await formats.list(guildId);
    const data = rows.map(cardOf);
    return { data, html: formatCardsHtml(data), limit: MAX_FORMATS_PER_GUILD };
  }

  server.get<{ Params: { token: string } }>('/formats/:token', async (_request, reply) => {
    const grant = await grants.owner(_request.params.token, 'formats');
    if (!grant) {
      return reply
        .code(403)
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(page('Конструктор форматов', formatsDenied(), { head: `<style>${FORMATS_STYLE}</style>` }));
    }

    const cards = await cardsPayload(grant.guildId);
    const html = page(
      'Конструктор форматов',
      formatsShell({
        token: grant.token,
        guildName: grant.guildId,
        games: TOURNAMENT_GAMES.map((game) => ({ value: game, label: TOURNAMENT_GAME_LABELS[game] })),
        cards: cards.data,
        limit: MAX_FORMATS_PER_GUILD,
      }),
      {
        description: 'Собери формат турнира из кирпичиков и запускай его по имени.',
        head: `<style>${FORMATS_STYLE}</style>`,
      },
    );

    // Страница персональная и содержит действующий пропуск: кэшировать её нельзя ни здесь,
    // ни у посредника. Драфт по той же причине отдаётся без кэша.
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
  });

  /**
   * Предпросмотр. Отдельным запросом, а не расчётом на странице: правила турнира живут на
   * сервере в одном экземпляре, и обещание «вот что получится» обязано считаться тем же
   * кодом, что потом строит сетку.
   */
  server.post<{ Params: { token: string }; Body: { bricks?: RawBricks } }>(
    '/api/formats/:token/preview',
    async (request, reply) => {
      const grant = await grants.owner(request.params.token, 'formats');
      if (!grant) return reply.code(403).send({ error: 'Ссылка не действует — попроси новую.' });

      try {
        return reply.header('cache-control', 'no-store').send(previewOf(normalizeBricks(readBricks(request.body?.bricks))));
      } catch (error) {
        // Противоречие в наборе — обычный ответ, а не сбой: человек как раз и двигает
        // кирпичики, чтобы увидеть, где предел.
        const described = describeForUser(error);
        if (described.incidentId) {
          deps.logger.error({ err: error, incidentId: described.incidentId }, 'предпросмотр формата упал');
          return reply.code(500).send({ error: described.text });
        }
        return reply.send({ error: described.text });
      }
    },
  );

  server.post<{
    Params: { token: string };
    Body: { name?: string; note?: string; bricks?: RawBricks; id?: number | null };
  }>('/api/formats/:token/save', async (request, reply) => {
    const grant = await grants.owner(request.params.token, 'formats');
    if (!grant) return reply.code(403).send({ error: 'Ссылка не действует — попроси новую.' });

    const name = (request.body?.name ?? '').trim();
    const bricks = readBricks(request.body?.bricks);
    bricks.note = request.body?.note ?? null;

    try {
      // Открытый в конструкторе формат переименовывается, а не двоится: человек правил
      // именно его, и «сохранить» для него значит «сохранить этот», а не «завести ещё один».
      const openId = typeof request.body?.id === 'number' ? request.body.id : null;
      const open = openId === null ? null : await formats.byId(grant.guildId, openId);
      if (open && open.name !== name) {
        await formats.rename(grant.guildId, open.id, name);
      }

      const saved = await formats.save({
        guildId: grant.guildId,
        name,
        createdBy: grant.userId,
        bricks,
      });

      return reply.header('cache-control', 'no-store').send({
        id: saved.row.id,
        created: saved.created && open === null,
        preview: saved.preview,
        cards: await cardsPayload(grant.guildId),
      });
    } catch (error) {
      const described = describeForUser(error);
      if (described.incidentId) {
        deps.logger.error({ err: error, incidentId: described.incidentId }, 'формат не сохранился');
        return reply.code(500).send({ error: described.text });
      }
      return reply.code(409).send({ error: described.text });
    }
  });

  server.post<{ Params: { token: string }; Body: { id?: number } }>(
    '/api/formats/:token/remove',
    async (request, reply) => {
      const grant = await grants.owner(request.params.token, 'formats');
      if (!grant) return reply.code(403).send({ error: 'Ссылка не действует — попроси новую.' });

      const id = request.body?.id;
      if (typeof id !== 'number') return reply.code(400).send({ error: 'Не понял, какой формат удалить.' });

      try {
        const removed = await formats.remove(grant.guildId, id);
        return reply
          .header('cache-control', 'no-store')
          .send({ removed: removed.name, cards: await cardsPayload(grant.guildId) });
      } catch (error) {
        const described = describeForUser(error);
        if (described.incidentId) {
          deps.logger.error({ err: error, incidentId: described.incidentId }, 'формат не удалился');
          return reply.code(500).send({ error: described.text });
        }
        return reply.code(404).send({ error: described.text });
      }
    },
  );
}
