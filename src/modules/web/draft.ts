import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import { describeForUser } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { draftProgress } from '../tournaments/draft/engine.js';
import { SUBJECT_LABELS, type DraftOption } from '../tournaments/draft/pools.js';
import { tournamentEntrants, tournamentMatches, tournaments } from '../tournaments/schema.js';
import { createDraftsService } from '../tournaments/services/drafts.js';
import { page, renderNotFound } from './render.js';
import { DRAFT_STYLE, draftShell } from './draft-page.js';

/**
 * Драфт на витрине: вето карт Valorant и баны с пиками героев Dota перед матчем.
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

interface DraftPayload {
  matchId: number;
  tournamentName: string;
  subject: 'heroes' | 'maps';
  subjectLabel: string;
  teams: { a: string; b: string };
  /** Сторона, за которую можно действовать. null — только смотреть. */
  you: 'a' | 'b' | null;
  step: number;
  total: number;
  current: { side: 'a' | 'b'; kind: 'ban' | 'pick' } | null;
  done: boolean;
  deadlineAt: string | null;
  banned: DraftOption[];
  picks: { a: DraftOption[]; b: DraftOption[] };
  available: DraftOption[];
  result: DraftOption[];
}

export function registerDraftRoutes(server: FastifyInstance, deps: DraftRoutesDeps): void {
  const { db } = deps;
  // Сервис здесь только читает и применяет ходы: создаёт драфты бот, когда появляются
  // комнаты матчей, и справочник героев нужен только там.
  const drafts = createDraftsService({ db, cache: deps.cache, logger: deps.logger });

  async function payload(matchId: number, token: string | undefined): Promise<DraftPayload | null> {
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

    const byId = new Map(draft.pool.map((option) => [option.id, option]));
    const resolve = (ids: string[]): DraftOption[] =>
      ids.map((id) => byId.get(id) ?? { id, label: id });

    const { total, done } = draftProgress(draft.sequence, state.choices);

    return {
      matchId,
      tournamentName: tournament?.name ?? 'Турнир',
      subject: draft.subject,
      subjectLabel: SUBJECT_LABELS[draft.subject].many,
      teams: { a: nameOf(match.entrantAId), b: nameOf(match.entrantBId) },
      you: drafts.sideOfToken(draft, token),
      step: done,
      total,
      current: state.view.current,
      done: state.view.done,
      deadlineAt: state.view.done ? null : (draft.deadlineAt?.toISOString() ?? null),
      banned: resolve(state.view.banned),
      picks: { a: resolve(state.view.pickedA), b: resolve(state.view.pickedB) },
      available: state.view.available,
      result: state.view.result,
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

      const state = await payload(matchId, request.query.as);
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
          page(
            `Драфт — ${state.tournamentName}`,
            draftShell(state),
            `<style>${DRAFT_STYLE}</style>`,
          ),
        );
    },
  );

  server.get<{ Params: { matchId: string }; Querystring: { as?: string } }>(
    '/api/draft/:matchId',
    async (request, reply) => {
      const matchId = parseId(request.params.matchId);
      const state = matchId === null ? null : await payload(matchId, request.query.as);
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

    const state = await payload(matchId, request.body?.token);
    return reply.header('cache-control', 'no-store').send(state);
  });
}
