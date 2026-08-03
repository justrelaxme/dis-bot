import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { Config } from '../../../src/core/config.js';
import { tournaments as tournamentsTable, type TournamentFormat } from '../../../src/modules/tournaments/schema.js';
import { createTournamentsService, type TournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

/**
 * Машина состояний матчей — второе по опасности место после арифметики сетки: ошибка здесь
 * не падает, а молча портит турнир, который нельзя переиграть. Проверяем против настоящего
 * Postgres, потому что вся защита от гонок здесь построена на условиях в WHERE, и на
 * заглушках она не проверяется вообще.
 */

let guildCounter = 0;

interface Started {
  service: TournamentsService;
  tournamentId: number;
  /** Участники в порядке создания: первый сильнейший, у него будет первый сид. */
  entrantIds: number[];
  users: string[];
}

async function startTournament(options: {
  registered: number;
  checkedIn?: number;
  format?: TournamentFormat;
  bus?: EventBus;
}): Promise<Started> {
  const checkedIn = options.checkedIn ?? options.registered;
  const service = createTournamentsService({
    db: pg.db,
    ...(options.bus ? { bus: options.bus } : {}),
  });

  guildCounter += 1;
  const guildId = `70000000000000${String(guildCounter).padStart(4, '0')}`;

  const tournament = await service.create({
    guildId,
    name: `Турнир ${guildCounter}`,
    game: 'dota2',
    format: options.format ?? 'single-elim',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 64,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: false,
    createdBy: 'organizer',
  });
  await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));

  const entrantIds: number[] = [];
  const users: string[] = [];
  for (let index = 0; index < options.registered; index += 1) {
    const user = `8${String(guildCounter).padStart(8, '0')}${String(index).padStart(8, '0')}`;
    const entrant = await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`);
    if (index < checkedIn) await service.checkIn(tournament.id, user);
    entrantIds.push(entrant.id);
    users.push(user);
  }

  // Сила убывает вместе с порядком, поэтому первый созданный получает первый сид.
  await service.start(
    tournament.id,
    new Map(entrantIds.map((id, index) => [id, 1_000 - index * 10])),
  );

  return { service, tournamentId: tournament.id, entrantIds, users };
}

/** Доигрывает сетку до конца: всегда побеждает участник с более высоким сидом. */
async function playToEnd(service: TournamentsService, tournamentId: number): Promise<void> {
  for (let guard = 0; guard < 300; guard += 1) {
    const view = await service.bracket(tournamentId);
    const next = view.matches.find(
      (match) => match.state === 'ready' && match.entrantAId !== null && match.entrantBId !== null,
    );
    if (!next) return;

    const seedOf = (id: number): number => view.entrants.find((entrant) => entrant.id === id)?.seed ?? 99;
    const a = next.entrantAId as number;
    const b = next.entrantBId as number;
    await service.settle(next.id, seedOf(a) <= seedOf(b) ? a : b, 'system', 'resolve', true);
  }
  throw new Error('сетка не доигралась за отведённое число шагов');
}

async function stateOf(tournamentId: number): Promise<string> {
  const [row] = await pg.db
    .select({ state: tournamentsTable.state })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  return row?.state ?? 'нет турнира';
}

describe('старт и форма сетки', () => {
  it('в сетку попадают только отметившиеся', async () => {
    const { service, tournamentId } = await startTournament({ registered: 8, checkedIn: 5 });
    const view = await service.bracket(tournamentId);

    const seeded = view.entrants.filter((entrant) => entrant.seed !== null);
    expect(seeded).toHaveLength(5);
    // Сетка на восемь: пятеро отметившихся округляются вверх до степени двойки.
    expect(view.matches.filter((match) => match.bracket === 'upper' && match.round === 1)).toHaveLength(4);
  });

  it('не стартует, когда отметилось меньше двоих', async () => {
    await expect(startTournament({ registered: 5, checkedIn: 1 })).rejects.toThrow(/Играть некому/);
  });

  it('пропуски первого круга проводятся сразу', async () => {
    const { service, tournamentId } = await startTournament({ registered: 5 });
    const view = await service.bracket(tournamentId);

    const byes = view.matches.filter(
      (match) => match.bracket === 'upper' && match.round === 1 && match.state === 'walkover',
    );
    // Сетка на восемь из пяти: трое старших сеяных проходят без игры.
    expect(byes).toHaveLength(3);
    expect(byes.every((match) => match.winnerEntrantId !== null)).toBe(true);
  });
});

/**
 * Регрессия на дефект, из-за которого турнир мог не закрыться **никогда**. Продвижение
 * победителя считало число кругов от числа регистраций, а сетка строится из отметившихся:
 * десять зарегистрированных при пяти пришедших давали сетку на 8 против расчёта на 16,
 * финал не распознавался финалом, событие о победителе не публиковалось, награда не
 * начислялась, комнаты не убирались — а суточный автомат потом отказывался начинать новый
 * день, потому что предыдущий турнир «не закрыт».
 */
describe('регрессия: турнир закрывается при неявках', () => {
  it.each([
    [10, 5],
    [16, 5],
    [16, 9],
    [8, 3],
  ])('зарегистрировано %i, отметилось %i — турнир доигрывается и закрывается', async (registered, checkedIn) => {
    const { service, tournamentId } = await startTournament({ registered, checkedIn });
    await playToEnd(service, tournamentId);

    expect(await stateOf(tournamentId)).toBe('finished');

    const [row] = await pg.db
      .select({ winner: tournamentsTable.winnerEntrantId })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));
    expect(row?.winner).not.toBeNull();
  });
});

describe('двойное устранение', () => {
  it('проигравший попадает в нижнюю сетку, победитель в верхнюю', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4, format: 'double-elim' });

    const before = await service.bracket(tournamentId);
    const first = before.matches.find(
      (match) => match.bracket === 'upper' && match.round === 1 && match.state === 'ready',
    );
    expect(first).toBeDefined();

    const winner = first?.entrantAId as number;
    const loser = first?.entrantBId as number;
    await service.settle(first?.id as number, winner, 'system', 'resolve', true);

    const after = await service.bracket(tournamentId);
    const upperNext = after.matches.find((match) => match.bracket === 'upper' && match.round === 2);
    const lowerFirst = after.matches.find((match) => match.bracket === 'lower' && match.round === 1);

    expect([upperNext?.entrantAId, upperNext?.entrantBId]).toContain(winner);
    expect([lowerFirst?.entrantAId, lowerFirst?.entrantBId]).toContain(loser);
  });

  it('турнир закрывается гранд-финалом, а не финалом верхней сетки', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4, format: 'double-elim' });

    // Доигрываем всё, кроме гранд-финала.
    for (let guard = 0; guard < 50; guard += 1) {
      const view = await service.bracket(tournamentId);
      const next = view.matches.find(
        (match) =>
          match.state === 'ready' &&
          match.bracket !== 'grand' &&
          match.entrantAId !== null &&
          match.entrantBId !== null,
      );
      if (!next) break;
      const seedOf = (id: number): number =>
        view.entrants.find((entrant) => entrant.id === id)?.seed ?? 99;
      const a = next.entrantAId as number;
      const b = next.entrantBId as number;
      await service.settle(next.id, seedOf(a) <= seedOf(b) ? a : b, 'system', 'resolve', true);
    }

    // Финал верхней сетки сыгран, а турнир ещё идёт: победитель ждёт в гранд-финале.
    expect(await stateOf(tournamentId)).toBe('running');

    const view = await service.bracket(tournamentId);
    const grand = view.matches.find((match) => match.bracket === 'grand');
    expect(grand?.state).toBe('ready');

    await service.settle(grand?.id as number, grand?.entrantAId as number, 'system', 'resolve', true);
    expect(await stateOf(tournamentId)).toBe('finished');
  });

  it('неполная сетка доигрывается, а матчи без участников помечены void', async () => {
    const { service, tournamentId } = await startTournament({ registered: 5, format: 'double-elim' });

    const view = await service.bracket(tournamentId);
    const voids = view.matches.filter((match) => match.state === 'void');
    expect(voids.length).toBeGreaterThan(0);
    expect(voids.every((match) => match.bracket === 'lower')).toBe(true);

    await playToEnd(service, tournamentId);
    expect(await stateOf(tournamentId)).toBe('finished');
  });
});

/**
 * Идемпотентность закрытия матча. Вся защита здесь — условия в WHERE того же UPDATE, и
 * проверять её можно только против настоящей базы. Двойное нажатие кнопки, повторная
 * доставка взаимодействия Discord и наложение автоподтверждения на ручное дают ровно один
 * результат, а не два продвижения по сетке.
 */
describe('идемпотентность закрытия матча', () => {
  it('повторное закрытие тем же победителем не продвигает дважды', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });
    const view = await service.bracket(tournamentId);
    const match = view.matches.find((row) => row.state === 'ready');
    const winner = match?.entrantAId as number;

    await service.settle(match?.id as number, winner, 'system', 'resolve', true);
    const second = await service.settle(match?.id as number, winner, 'system', 'resolve', true);
    expect(second.finished).toBe(false);

    const after = await service.bracket(tournamentId);
    const parent = after.matches.find((row) => row.bracket === 'upper' && row.round === 2);
    // Победитель стоит в родителе один раз, а не в двух слотах.
    const occupied = [parent?.entrantAId, parent?.entrantBId].filter((id) => id === winner);
    expect(occupied).toHaveLength(1);
  });

  it('закрыть матч другим победителем после закрытия нельзя', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });
    const view = await service.bracket(tournamentId);
    const match = view.matches.find((row) => row.state === 'ready');

    await service.settle(match?.id as number, match?.entrantAId as number, 'system', 'resolve', true);
    await expect(
      service.settle(match?.id as number, match?.entrantBId as number, 'system', 'resolve', true),
    ).rejects.toThrow(/уже закрыт/);
  });

  it('повторная заявка результата отклоняется', async () => {
    const { service, tournamentId, users } = await startTournament({ registered: 4 });
    const view = await service.bracket(tournamentId);
    const match = view.matches.find((row) => row.state === 'ready');
    const reporter = view.entrants.find((entrant) => entrant.id === match?.entrantAId)?.captainUserId;

    await service.report(match?.id as number, reporter as string, match?.entrantAId as number);
    await expect(
      service.report(match?.id as number, reporter as string, match?.entrantAId as number),
    ).rejects.toThrow(/уже заявлен/);
    expect(users.length).toBeGreaterThan(0);
  });

  it('подтвердить свой же результат нельзя', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });
    const view = await service.bracket(tournamentId);
    const match = view.matches.find((row) => row.state === 'ready');
    const reporter = view.entrants.find((entrant) => entrant.id === match?.entrantAId)?.captainUserId;

    await service.report(match?.id as number, reporter as string, match?.entrantAId as number);
    await expect(service.confirm(match?.id as number, reporter as string)).rejects.toThrow(
      /подтверждает соперник/,
    );
  });

  it('подтверждение соперником закрывает матч', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });
    const view = await service.bracket(tournamentId);
    const match = view.matches.find((row) => row.state === 'ready');
    const reporter = view.entrants.find((entrant) => entrant.id === match?.entrantAId)?.captainUserId;
    const opponent = view.entrants.find((entrant) => entrant.id === match?.entrantBId)?.captainUserId;

    await service.report(match?.id as number, reporter as string, match?.entrantAId as number);
    const result = await service.confirm(match?.id as number, opponent as string);

    expect(result.match.state).toBe('confirmed');
    expect(result.match.winnerEntrantId).toBe(match?.entrantAId);
  });
});

describe('событие о победителе', () => {
  it('публикуется один раз, даже если закрытие вызвали дважды', async () => {
    const bus = new EventBus(logger);
    const winners: string[][] = [];
    bus.on('tournament.finished', async (payload) => {
      winners.push(payload.winnerUserIds);
    });

    const { service, tournamentId } = await startTournament({ registered: 2, bus });
    const view = await service.bracket(tournamentId);
    const final = view.matches.find((row) => row.state === 'ready');
    const winner = final?.entrantAId as number;

    await service.settle(final?.id as number, winner, 'system', 'resolve', true);
    await service.settle(final?.id as number, winner, 'system', 'resolve', true);

    expect(await stateOf(tournamentId)).toBe('finished');
    expect(winners).toHaveLength(1);
    // Состав победителя уходит списком людей: подписчику нужны те, кому начислять.
    expect(winners[0]).toHaveLength(1);
  });
});

/**
 * Час молчания соперника — самый частый путь, которым закрывается последний матч
 * ежедневного турнира. Признак «турнир закончился» должен доехать до вызывающего: пока он
 * терялся, джоба принимала результат и ничего больше не делала, а голосовые комнаты команд
 * оставались на сервере навсегда. Уборка живёт у вызывающего, поэтому проверяем именно то,
 * по чему он её решает запустить.
 */
describe('приём результата по молчанию соперника', () => {
  it('о закрытии турнира сообщает наверх, а не только принимает матч', async () => {
    const { service, tournamentId, entrantIds, users } = await startTournament({ registered: 2 });

    const view = await service.bracket(tournamentId);
    const final = view.matches.find((match) => match.state === 'ready');
    expect(final).toBeDefined();
    await service.report(final?.id as number, users[0] as string, entrantIds[0] as number);

    // Смотрим из будущего вместо правки reportedAt в базе: порог считается от переданного
    // времени, и подделывать строку ради этого незачем. Приём результатов идёт по всей базе,
    // поэтому ищем свой матч, а не полагаемся на длину: тесты делят одну базу.
    const settled = await service.autoConfirmDue(new Date(Date.now() + 10 * 60 * 60 * 1_000), 50);
    const mine = settled.find((entry) => entry.match.id === final?.id);

    expect(mine, 'матч не приняли по молчанию').toBeDefined();
    expect(mine?.finished, 'турнир закрылся, но джоба об этом не узнала').toBe(true);
    expect(await stateOf(tournamentId)).toBe('finished');
  });

  it('матч в середине сетки турнир не закрывает', async () => {
    const { service, tournamentId, entrantIds, users } = await startTournament({ registered: 4 });

    const view = await service.bracket(tournamentId);
    const first = view.matches.find((match) => match.state === 'ready');
    const reporter = view.entrants.find((entrant) => entrant.id === first?.entrantAId);
    const index = entrantIds.indexOf(reporter?.id as number);
    await service.report(first?.id as number, users[index] as string, reporter?.id as number);

    const settled = await service.autoConfirmDue(new Date(Date.now() + 10 * 60 * 60 * 1_000), 50);
    const mine = settled.find((entry) => entry.match.id === first?.id);

    expect(mine, 'матч не приняли по молчанию').toBeDefined();
    expect(mine?.finished, 'матч первого круга не должен закрывать турнир').toBe(false);
    expect(await stateOf(tournamentId)).toBe('running');
  });
});

describe('брошенный турнир', () => {
  it('распознаётся по отсутствию изменений и не трогает живой', async () => {
    const stale = await startTournament({ registered: 4 });
    const fresh = await startTournament({ registered: 4 });

    // Отматываем время последнего изменения матчей и старта у первого турнира.
    const long = new Date(Date.now() - 12 * 60 * 60 * 1_000);
    await pg.db
      .update(tournamentsTable)
      .set({ startedAt: long })
      .where(eq(tournamentsTable.id, stale.tournamentId));
    await pg.db.execute(
      sql`update tournament_matches set updated_at = ${long} where tournament_id = ${stale.tournamentId}`,
    );

    const found = await stale.service.staleRunning(new Date(), 6 * 60 * 60 * 1_000);
    const ids = found.map((row) => row.tournament.id);

    expect(ids).toContain(stale.tournamentId);
    expect(ids).not.toContain(fresh.tournamentId);
    // Незакрытые матчи есть — значит турнир брошен, а не «должен был закрыться сам».
    expect(found.find((row) => row.tournament.id === stale.tournamentId)?.openMatches).toBeGreaterThan(0);
  });

  it('доигранный турнир в брошенные не попадает', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });
    await playToEnd(service, tournamentId);

    const found = await service.staleRunning(new Date(), 0);
    expect(found.map((row) => row.tournament.id)).not.toContain(tournamentId);
  });
});
