import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import { describeForUser } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { draftProgress } from '../tournaments/draft/engine.js';
import type { DraftGroup, DraftOption } from '../tournaments/draft/pools.js';
import { tournamentEntrants, tournamentMatches, tournaments, type TournamentGame } from '../tournaments/schema.js';
import { createDraftsService } from '../tournaments/services/drafts.js';
import { page, renderNotFound } from './render.js';
import { DRAFT_STYLE, draftShell } from './draft-page.js';

/**
 * Драфт на витрине: вето карт и пики с банами агентов в Valorant, баны и пики героев в Dota.
 *
 * Право действовать даёт **ссылка**, а не вход на сайт. Витрина по устройству анонимна и
 * только для чтения, а драфт требует знать, кто нажимает: банить за команду может лишь её
 * капитан. Ссылку с неугадываемым токеном раздаёт бот в личные сообщения — то есть доступ
 * по-прежнему выдаёт Discord, как и всё остальное управление. Без токена страница
 * открывается, но только смотреть: она же и трансляция для остальных.
 */

export interface DraftRoutesDeps {
  db: Database;
  cache: Cache;
  logger: Logger;
}

/** Кто занял вариант. Свободных в карте нет — отсутствие ключа и означает «свободен». */
type OptionState = 'banned' | 'a' | 'b';

interface DraftPhaseView {
  /**
   * Всегда заполнен: у драфтов, заведённых до появления фаз, набора у шагов нет, и здесь
   * подставляется `subject` самого драфта. Странице нужен конкретный набор — от него зависит
   * и размер плиток, и то, какие варианты попадают в эту фазу.
   */
  group: DraftGroup;
  total: number;
  done: number;
  /** Итог фазы идентификаторами: сам вариант страница найдёт в пуле, который у неё уже есть. */
  resultIds: string[];
}

interface DraftPayload {
  matchId: number;
  tournamentName: string;
  game: TournamentGame;
  teams: { a: string; b: string };
  /** Сторона, за которую можно действовать. null — только смотреть. */
  you: 'a' | 'b' | null;
  step: number;
  total: number;
  current: { side: 'a' | 'b'; kind: 'ban' | 'pick'; group: DraftGroup } | null;
  done: boolean;
  deadlineAt: string | null;
  /**
   * Полный пул. Приходит один раз — вместе со страницей, — и в ответах опроса его нет:
   * снимок пула не меняется за время драфта, а сто двадцать семь героев каждые две секунды
   * это тридцать килобайт на пустом месте.
   */
  pool?: DraftOption[];
  states: Record<string, OptionState>;
  /** Порядок банов и пиков: он нужен плашкам, а по состояниям порядок не восстановить. */
  banned: string[];
  picks: { a: string[]; b: string[] };
  phases: DraftPhaseView[];
}

export function registerDraftRoutes(server: FastifyInstance, deps: DraftRoutesDeps): void {
  const { db } = deps;
  // Сервис здесь только читает и применяет ходы: создаёт драфты бот, когда появляются
  // комнаты матчей, и справочники нужны только там.
  const drafts = createDraftsService({ db, cache: deps.cache, logger: deps.logger });

  async function payload(
    matchId: number,
    token: string | undefined,
    options: { withPool: boolean },
  ): Promise<DraftPayload | null> {
    const draft = await drafts.byMatch(matchId);
    if (!draft) return null;

    const state = await drafts.state(draft);
    const [match] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, matchId));
    if (!match) return null;

    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, draft.tournamentId));
    const entrants = await db
      .select()
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, draft.tournamentId));

    const nameOf = (id: number | null): string =>
      entrants.find((entrant) => entrant.id === id)?.displayName ?? '—';

    const states: Record<string, OptionState> = {};
    for (const id of state.view.banned) states[id] = 'banned';
    for (const id of state.view.pickedA) states[id] = 'a';
    for (const id of state.view.pickedB) states[id] = 'b';

    const { total } = draftProgress(draft.sequence, state.choices);
    // Набор для шагов без пометки — `subject` драфта: так странице всегда достаётся
    // конкретный набор, включая записи, заведённые до появления фаз.
    const groupOf = (group: DraftGroup | undefined): DraftGroup => group ?? draft.subject;

    return {
      matchId,
      tournamentName: tournament?.name ?? 'Турнир',
      game: tournament?.game ?? 'valorant',
      teams: { a: nameOf(match.entrantAId), b: nameOf(match.entrantBId) },
      you: drafts.sideOfToken(draft, token),
      step: state.view.step,
      total,
      current: state.view.current
        ? { ...state.view.current, group: groupOf(state.view.current.group) }
        : null,
      done: state.view.done,
      deadlineAt: state.view.done ? null : (draft.deadlineAt?.toISOString() ?? null),
      ...(options.withPool
        ? { pool: draft.pool.map((option) => ({ ...option, group: groupOf(option.group) })) }
        : {}),
      states,
      banned: state.view.banned,
      picks: { a: state.view.pickedA, b: state.view.pickedB },
      phases: state.view.phases.map((phase) => ({
        group: groupOf(phase.group),
        total: phase.total,
        done: phase.done,
        resultIds: phase.result.map((option) => option.id),
      })),
    };
  }

  function parseId(raw: string): number | null {
    const id = Number.parseInt(raw, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  server.get<{ Params: { matchId: string }; Querystring: { as?: string } }>(
    '/draft/:matchId',
    async (request, reply) => {
      const matchId = parseId(request.params.matchId);
      if (matchId === null) {
        return reply
          .code(404)
          .type('text/html; charset=utf-8')
          .send(page('Не найдено', renderNotFound('Такого матча нет.')));
      }

      const state = await payload(matchId, request.query.as, { withPool: true });
      if (!state) {
        return reply
          .code(404)
          .type('text/html; charset=utf-8')
          .send(
            page(
              'Драфт не найден',
              renderNotFound('Для этого матча драфт не заводился — играйте без него.'),
            ),
          );
      }

      // Страница не кэшируется вовсе: она обновляется ходами, а не по расписанию.
      return reply
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(
          page(`Драфт — ${state.tournamentName}`, draftShell(state), {
            game: state.game,
            head: `<style>${DRAFT_STYLE}</style>`,
          }),
        );
    },
  );

  server.get<{ Params: { matchId: string }; Querystring: { as?: string } }>(
    '/api/draft/:matchId',
    async (request, reply) => {
      const matchId = parseId(request.params.matchId);
      const state = matchId === null ? null : await payload(matchId, request.query.as, { withPool: false });
      if (!state) return reply.code(404).send({ error: 'Драфт не найден.' });
      return reply.header('cache-control', 'no-store').send(state);
    },
  );

  server.post<{
    Params: { matchId: string };
    Body: { token?: string; optionId?: string | null };
  }>('/api/draft/:matchId/choose', async (request, reply) => {
    const matchId = parseId(request.params.matchId);
    if (matchId === null) return reply.code(404).send({ error: 'Матч не найден.' });

    const draft = await drafts.byMatch(matchId);
    if (!draft) return reply.code(404).send({ error: 'Драфт не найден.' });

    const side = drafts.sideOfToken(draft, request.body?.token);
    if (!side) {
      // Без действующей ссылки — только смотреть. Отдельный код, чтобы страница могла
      // сказать «эта ссылка не даёт ходить», а не «что-то пошло не так».
      return reply.code(403).send({ error: 'Эта ссылка не даёт делать ходы — она для просмотра.' });
    }

    try {
      await drafts.choose(draft.id, side, request.body?.optionId ?? null, `web:${side}`);
    } catch (error) {
      const described = describeForUser(error);
      if (described.incidentId) {
        deps.logger.error({ err: error, incidentId: described.incidentId }, 'ход драфта не применился');
        return reply.code(500).send({ error: described.text });
      }
      return reply.code(409).send({ error: described.text });
    }

    const state = await payload(matchId, request.body?.token, { withPool: false });
    return reply.header('cache-control', 'no-store').send(state);
  });
}
