import type { FastifyInstance } from 'fastify';
import type { Database } from '../../core/db/client.js';
import { describeForUser } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { RosterFailure } from '../identity/providers/hoyolab.js';
import { explainRosterFailure } from '../identity/providers/hoyolab.js';
import { GENSHIN_ROSTER } from '../tournaments/draft/pools.js';
import { entryOf, createRostersService } from '../tournaments/services/rosters.js';
import { genshinUidOfUser } from '../tournaments/services/strength.js';
import { createTournamentsService } from '../tournaments/services/tournaments.js';
import { createGrantsService } from './grants.js';
import { ROSTER_STYLE, rosterDenied, rosterShell } from './roster-page.js';
import { page } from './render.js';

/**
 * Заявка состава на турнир: страница игрока и её единственное действие — сохранить.
 *
 * До заявки надо пройти четыре условия, и каждое из них — законное состояние, а не сбой:
 * турнир должен идти, он должен быть по Genshin, у игрока должна быть подтверждённая привязка,
 * а его Летопись — открыта. Поэтому отказы здесь не общие: человеку важно знать, что чинить —
 * привязку, настройку приватности или ничего, потому что турнира просто нет.
 */

export interface RosterRoutesDeps {
  db: Database;
  logger: Logger;
  /**
   * Летопись HoYoLAB: единственный источник, который знает, что у игрока есть. Без неё заявка
   * невозможна вовсе — заявлять было бы из чего угодно.
   */
  chronicle?:
    | {
        configured: boolean;
        roster(
          uid: string,
        ): Promise<{ ok: true; characters: readonly OwnedForRoster[] } | { ok: false; reason: RosterFailure }>;
      }
    | undefined;
}

/**
 * Персонаж из Летописи в том объёме, который нужен заявке. Тип структурный, а не
 * импортированный: витрине незачем знать устройство модуля личности, а тому — подстраиваться
 * под витрину.
 */
export interface OwnedForRoster {
  id: string;
  name: string;
  rarity: number;
  constellation: number;
  iconUrl?: string | undefined;
  weapon?: { name: string; rarity: number; refinement: number } | undefined;
  sets: { name: string; pieces: number }[];
}

/** Что нашлось до заявки: турнир, аккаунт и его состав — или причина, по которой не вышло. */
type Ready =
  | {
      ok: true;
      tournamentId: number;
      tournamentName: string;
      cap: number | null;
      immunities: number;
      uid: string;
      owned: readonly OwnedForRoster[];
    }
  | { ok: false; reason: string };

export function registerRosterRoutes(server: FastifyInstance, deps: RosterRoutesDeps): void {
  const grants = createGrantsService({ db: deps.db });
  const tournaments = createTournamentsService({ db: deps.db });
  const rosters = createRostersService({ db: deps.db });

  /**
   * Всё, что нужно для заявки, и по одной причине отказа на каждое препятствие.
   *
   * Собрано в одном месте, потому что и страница, и сохранение проходят ровно этот же путь: у
   * страницы иначе показалось бы одно, а сохранилось бы по другому — например, потолок успел бы
   * поменяться между открытием и нажатием.
   */
  async function readyFor(guildId: string, userId: string): Promise<Ready> {
    if (!deps.chronicle?.configured) {
      return {
        ok: false,
        reason:
          'Чтение составов на этом сервере не настроено — у бота нет ключа HoYoLAB. Заявку собрать не из чего.',
      };
    }

    const tournament = await tournaments.current(guildId);
    if (!tournament) {
      return { ok: false, reason: 'Сейчас на сервере нет идущего турнира — заявлять состав некуда.' };
    }
    if (tournament.game !== 'genshin') {
      return {
        ok: false,
        reason: `Текущий турнир не по Genshin, а заявка состава бывает только там: в остальных дисциплинах бот не знает, что у тебя есть.`,
      };
    }

    const uid = await genshinUidOfUser(deps.db, userId);
    if (!uid) {
      return {
        ok: false,
        reason:
          'Аккаунт Genshin не привязан или не подтверждён. Привяжи его командой `/link genshin` — без подтверждения любой заявил бы чужой состав.',
      };
    }

    const roster = await deps.chronicle.roster(uid);
    if (!roster.ok) return { ok: false, reason: explainRosterFailure(roster.reason) };

    return {
      ok: true,
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      cap: tournament.costCap,
      immunities: tournament.immunities,
      uid,
      owned: roster.characters,
    };
  }

  server.get<{ Params: { token: string } }>('/roster/:token', async (request, reply) => {
    const grant = await grants.owner(request.params.token, 'roster');
    const html = async (): Promise<string> => {
      if (!grant) {
        return page(
          'Мой состав',
          rosterDenied(
            'Ссылка не действует. Пропуск живёт сутки и на человека он один — новая ссылка гасит прежнюю. Попроси новую командой `/roster` в Discord.',
          ),
          { game: 'genshin', head: `<style>${ROSTER_STYLE}</style>` },
        );
      }

      const ready = await readyFor(grant.guildId, grant.userId);
      if (!ready.ok) {
        return page('Мой состав', rosterDenied(ready.reason), {
          game: 'genshin',
          head: `<style>${ROSTER_STYLE}</style>`,
        });
      }

      const saved = await rosters.byPlayer(ready.tournamentId, grant.userId);
      const owned = ready.owned.map(entryOf);

      return page(
        'Мой состав',
        rosterShell({
          token: grant.token,
          tournamentName: ready.tournamentName,
          cap: ready.cap,
          immunities: ready.immunities,
          limit: GENSHIN_ROSTER,
          // Дорогие вперёд: решение принимают, глядя на то, что съедает бюджет, а бесплатные
          // четырёхзвёздочные добираются в конце и без раздумий.
          owned: owned.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name, 'ru')),
          chosen: (saved?.characters ?? []).map((character) => character.id),
          immune: saved?.immune ?? [],
          nickname: ready.uid,
        }),
        {
          game: 'genshin',
          description: 'Свой состав на турнир: персонажи, оружие и бюджет.',
          head: `<style>${ROSTER_STYLE}</style>`,
        },
      );
    };

    // Страница персональная и содержит действующий пропуск: кэшировать её нельзя.
    return reply
      .code(grant ? 200 : 403)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(await html());
  });

  server.post<{ Params: { token: string }; Body: { characterIds?: unknown; immuneIds?: unknown } }>(
    '/api/roster/:token',
    async (request, reply) => {
      const grant = await grants.owner(request.params.token, 'roster');
      if (!grant) return reply.code(403).send({ error: 'Ссылка не действует — попроси новую.' });

      const ids = request.body?.characterIds;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        return reply.code(400).send({ error: 'Не понял, кого заявляют.' });
      }

      // Состав читается заново, а не берётся с открытой страницы: между открытием и нажатием
      // человек мог что-то выкрутить, и заявка обязана считаться по тому, что есть сейчас.
      const ready = await readyFor(grant.guildId, grant.userId);
      if (!ready.ok) return reply.code(409).send({ error: ready.reason });

      try {
        const saved = await rosters.submit({
          tournamentId: ready.tournamentId,
          userId: grant.userId,
          externalId: ready.uid,
          characterIds: ids as string[],
          cap: ready.cap,
          owned: ready.owned,
        });

        return reply
          .header('cache-control', 'no-store')
          .send({ count: saved.characters.length, spent: saved.spent });
      } catch (error) {
        const described = describeForUser(error);
        if (described.incidentId) {
          deps.logger.error({ err: error, incidentId: described.incidentId }, 'заявка состава не сохранилась');
          return reply.code(500).send({ error: described.text });
        }
        return reply.code(409).send({ error: described.text });
      }
    },
  );
}
