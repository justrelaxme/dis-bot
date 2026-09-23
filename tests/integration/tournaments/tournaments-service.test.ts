import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { Config } from '../../../src/core/config.js';
import {
  tournamentMatches as tournamentMatchesTable,
  tournaments as tournamentsTable,
  type TournamentFormat,
} from '../../../src/modules/tournaments/schema.js';
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

/**
 * Счёт. Проверить его боту нечем, поэтому вся защита — согласие с названным победителем и
 * перенос заявленного счёта в закрытый матч. Ошибка здесь остаётся в сетке и зале славы
 * навсегда.
 */
describe('счёт матча', () => {
  async function firstMatch(registered: number) {
    const started = await startTournament({ registered });
    const view = await started.service.bracket(started.tournamentId);
    const match = view.matches.find((row) => row.state === 'ready');
    if (!match) throw new Error('матч не построился');
    return { ...started, match };
  }

  it('заявленный счёт становится счётом матча после подтверждения', async () => {
    const { service, entrantIds, users, match } = await firstMatch(2);
    const winner = match.entrantAId as number;
    const winnerIndex = entrantIds.indexOf(winner);
    const loserIndex = winnerIndex === 0 ? 1 : 0;

    await service.report(match.id, users[winnerIndex] as string, winner, { a: 13, b: 8 });

    // До подтверждения счёт матча пуст: заявка ещё не результат.
    const reported = await service.matchById(match.id);
    expect(reported.scoreA).toBeNull();
    expect(reported.reportedScoreA).toBe(13);

    await service.confirm(match.id, users[loserIndex] as string);

    const settled = await service.matchById(match.id);
    expect(settled.scoreA).toBe(13);
    expect(settled.scoreB).toBe(8);
  });

  it('счёт против названного победителя не принимается', async () => {
    const { service, entrantIds, users, match } = await firstMatch(2);
    const winner = match.entrantAId as number;
    const winnerIndex = entrantIds.indexOf(winner);

    // Победила сторона A, а счёт говорит, что больше у B.
    await expect(
      service.report(match.id, users[winnerIndex] as string, winner, { a: 8, b: 13 }),
    ).rejects.toThrow(/выиграл/);

    // Заявки не случилось вовсе: матч остался готовым к игре.
    expect((await service.matchById(match.id)).state).toBe('ready');
  });

  it('без счёта матч закрывается как раньше', async () => {
    const { service, entrantIds, users, match } = await firstMatch(2);
    const winner = match.entrantAId as number;
    const winnerIndex = entrantIds.indexOf(winner);
    const loserIndex = winnerIndex === 0 ? 1 : 0;

    await service.report(match.id, users[winnerIndex] as string, winner);
    await service.confirm(match.id, users[loserIndex] as string);

    const settled = await service.matchById(match.id);
    expect(settled.winnerEntrantId).toBe(winner);
    expect(settled.scoreA).toBeNull();
    expect(settled.scoreB).toBeNull();
  });

  /** Победу без игры не играли — счёта у неё быть не может, даже если он был заявлен. */
  it('победа без игры счёта не получает', async () => {
    const { service, match } = await firstMatch(2);
    const winner = match.entrantAId as number;

    await service.settle(match.id, winner, 'organizer', 'walkover', true, { a: 13, b: 0 });

    const settled = await service.matchById(match.id);
    expect(settled.state).toBe('walkover');
    expect(settled.scoreA).toBeNull();
  });
});

/**
 * Автосбор составов. Проверяется против настоящего Postgres, потому что перенос человека из
 * одного участника в другого упирается в уникальность «один человек — один участник в турнире»,
 * и порядок операций там существен: на заглушке это не проверяется вообще.
 */
describe('автосбор составов из одиночек', () => {
  async function withSignups(count: number, teamSize: number) {
    guildCounter += 1;
    const guildId = `63000000000000${String(guildCounter).padStart(4, '0')}`;
    const service = createTournamentsService({ db: pg.db });

    const tournament = await service.create({
      guildId,
      name: `Автосбор ${guildCounter}`,
      game: 'dota2',
      format: 'single-elim',
      entryMode: 'team',
      teamSize,
      maxEntrants: 64,
      seeding: 'rank',
      bestOf: 1,
      autoTeams: true,
      requireVerified: false,
      createdBy: 'organizer',
    });
    await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));

    const strengths = new Map<number, number>();
    for (let index = 0; index < count; index += 1) {
      const user = `64${String(guildCounter).padStart(7, '0')}${String(index).padStart(7, '0')}`;
      const entrant = await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`);
      await service.checkIn(tournament.id, user);
      strengths.set(entrant.id, 5_000 - index * 100);
    }

    return { service, tournamentId: tournament.id, strengths };
  }

  it('десять одиночек становятся двумя составами по пять', async () => {
    const { service, tournamentId, strengths } = await withSignups(10, 5);

    const assembled = await service.assembleTeams(tournamentId, strengths);

    expect(assembled.teams).toBe(2);
    expect(assembled.benched).toEqual([]);

    const entrants = await service.activeEntrants(tournamentId);
    expect(entrants).toHaveLength(2);
    for (const entrant of entrants) {
      expect(await service.membersOf(entrant.id)).toHaveLength(5);
      // Название даёт бот: капитана до раздачи нет, и назвать состав некому.
      expect(entrant.displayName).not.toMatch(/^Игрок/);
    }
  });

  /**
   * Лишние выходят из турнира. Добрать состав до размера кем попало нельзя: место в неполной
   * команде выглядит участием, а против полной пятёрки такой состав проигрывает механически.
   */
  it('лишние остаются вне сетки и названы по именам', async () => {
    const { service, tournamentId, strengths } = await withSignups(12, 5);

    const assembled = await service.assembleTeams(tournamentId, strengths);

    expect(assembled.teams).toBe(2);
    expect(assembled.benched).toHaveLength(2);
    expect(await service.activeEntrants(tournamentId)).toHaveLength(2);
  });

  it('никто не оказывается в двух составах сразу', async () => {
    const { service, tournamentId, strengths } = await withSignups(10, 5);
    await service.assembleTeams(tournamentId, strengths);

    const entrants = await service.activeEntrants(tournamentId);
    const members = (await Promise.all(entrants.map((entrant) => service.membersOf(entrant.id)))).flat();

    expect(new Set(members).size).toBe(members.length);
    expect(members).toHaveLength(10);
  });

  it('меньше чем на один состав — не собираем никого', async () => {
    const { service, tournamentId, strengths } = await withSignups(4, 5);

    const assembled = await service.assembleTeams(tournamentId, strengths);

    expect(assembled.teams).toBe(0);
    // Никого не выкинули: турнир просто не состоится, и решать это будет старт.
    expect(await service.activeEntrants(tournamentId)).toHaveLength(4);
  });

  /**
   * Если хоть кто-то пришёл компанией, автосбор не вмешивается вовсе. Разводить по разным
   * составам людей, которые записались вместе, нельзя: они за этим и собирались, а бот об их
   * договорённости не знает ничего, кроме того, что она есть.
   */
  it('команды, собранные руками, не разбираются', async () => {
    guildCounter += 1;
    const guildId = `65000000000000${String(guildCounter).padStart(4, '0')}`;
    const service = createTournamentsService({ db: pg.db });

    const tournament = await service.create({
      guildId,
      name: `Смешанный ${guildCounter}`,
      game: 'dota2',
      format: 'single-elim',
      entryMode: 'team',
      teamSize: 2,
      maxEntrants: 64,
      seeding: 'rank',
      bestOf: 1,
      autoTeams: true,
      requireVerified: false,
      createdBy: 'organizer',
    });
    await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));

    const user = (index: number): string =>
      `66${String(guildCounter).padStart(7, '0')}${String(index).padStart(7, '0')}`;

    // Двое пришли вместе, двое записались по одному.
    const pair = await service.createEntrant(tournament.id, user(0), 'Друзья');
    await service.joinEntrant(pair.id, user(1));
    await service.checkIn(tournament.id, user(0));
    const alone1 = await service.createEntrant(tournament.id, user(2), 'Одиночка 1');
    await service.checkIn(tournament.id, user(2));
    const alone2 = await service.createEntrant(tournament.id, user(3), 'Одиночка 2');
    await service.checkIn(tournament.id, user(3));

    const assembled = await service.assembleTeams(
      tournament.id,
      new Map([
        [pair.id, 5_000],
        [alone1.id, 4_000],
        [alone2.id, 3_000],
      ]),
    );

    expect(assembled.teams, 'автосбор вмешался в собранную руками команду').toBe(0);
    // Ничего не тронуто: все три участника на месте, «Друзья» по-прежнему вдвоём.
    expect(await service.activeEntrants(tournament.id)).toHaveLength(3);
    expect(await service.membersOf(pair.id)).toHaveLength(2);
  });

  it('после сбора сетка строится на составах, а не на людях', async () => {
    const { service, tournamentId, strengths } = await withSignups(10, 5);
    await service.assembleTeams(tournamentId, strengths);

    const fresh = new Map((await service.activeEntrants(tournamentId)).map((entrant) => [entrant.id, 1_000]));
    const view = await service.start(tournamentId, fresh);

    expect(view.entrants.filter((entrant) => entrant.seed !== null)).toHaveLength(2);
    expect(view.matches.filter((match) => match.state === 'ready')).toHaveLength(1);
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

/**
 * Комнаты турнира для уборки. Отдельный запрос от «активных участников», и это как раз то,
 * из-за чего комнаты оставались на сервере: снявшийся участник свою комнату не забирает, а
 * уборка ходила по активным и его не видела.
 */
describe('комнаты турнира для уборки', () => {
  it('в список попадают комнаты и снявшихся участников', async () => {
    const { service, tournamentId, entrantIds } = await startTournament({ registered: 4 });
    const [first, second] = entrantIds;
    if (first === undefined || second === undefined) throw new Error('участники не создались');

    await service.attachVoice(first, 'voice-остался');
    await service.attachVoice(second, 'voice-снялся');
    // Снятие руками организатора — обычный путь, по которому комната и «терялась».
    await pg.db.execute(
      sql`update tournament_entrants set withdrawn_at = now() where id = ${second}`,
    );

    const rooms = await service.tournamentVoiceRooms(tournamentId);

    expect(rooms).toContain('voice-остался');
    expect(rooms).toContain('voice-снялся');
    expect(await service.activeEntrants(tournamentId)).not.toContainEqual(
      expect.objectContaining({ id: second }),
    );
  });

  it('участник без комнаты в список не попадает', async () => {
    const { service, tournamentId, entrantIds } = await startTournament({ registered: 2 });
    const [first] = entrantIds;
    if (first === undefined) throw new Error('участник не создался');

    await service.attachVoice(first, 'voice-один');

    expect(await service.tournamentVoiceRooms(tournamentId)).toEqual(['voice-один']);
  });

  it('чужие турниры не попадают', async () => {
    const mine = await startTournament({ registered: 2 });
    const other = await startTournament({ registered: 2 });
    const [myFirst] = mine.entrantIds;
    const [otherFirst] = other.entrantIds;
    if (myFirst === undefined || otherFirst === undefined) throw new Error('участники не создались');

    await mine.service.attachVoice(myFirst, 'voice-мой');
    await other.service.attachVoice(otherFirst, 'voice-чужой');

    expect(await mine.service.tournamentVoiceRooms(mine.tournamentId)).toEqual(['voice-мой']);
  });
});

/**
 * Закрытие доигранного турнира в Discord — ровно один раз. Путей к финалу пять, и кнопка с
 * джобой могут прийти к нему одновременно: второй «итог» в канале уже не отменить.
 */
describe('закрытие турнира синхронизатором', () => {
  it('занять закрытие удаётся один раз', async () => {
    const { service, tournamentId } = await startTournament({ registered: 2 });
    await playToEnd(service, tournamentId);

    const [first, second] = await Promise.all([
      service.claimCloseOut(tournamentId),
      service.claimCloseOut(tournamentId),
    ]);

    expect([first, second].filter((row) => row !== null)).toHaveLength(1);
  });

  it('идущий турнир закрыть нельзя — только доигранный', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });

    await expect(service.claimCloseOut(tournamentId)).resolves.toBeNull();
  });

  /** Отменённый убирают сами пути отмены — синхронизатору там делать нечего. */
  it('отмена сразу помечает турнир закрытым', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });

    await service.cancel(tournamentId);

    const [row] = await pg.db.select().from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
    expect(row?.closedOutAt).not.toBeNull();
    await expect(service.claimCloseOut(tournamentId)).resolves.toBeNull();
  });

  it('в работу синхронизатору попадают идущие и незакрытые доигранные', async () => {
    const running = await startTournament({ registered: 4 });
    const finished = await startTournament({ registered: 2 });
    await playToEnd(finished.service, finished.tournamentId);
    const closed = await startTournament({ registered: 2 });
    await playToEnd(closed.service, closed.tournamentId);
    await closed.service.claimCloseOut(closed.tournamentId);

    const ids = (await running.service.needingSync()).map((row) => row.id);

    expect(ids).toContain(running.tournamentId);
    expect(ids).toContain(finished.tournamentId);
    expect(ids).not.toContain(closed.tournamentId);
  });
});

/** Итог говорит, как закрылся финал: оговорка «по молчанию» верна только про молчание. */
describe('как закрылся финал', () => {
  it('подтверждение соперником', async () => {
    const { service, tournamentId, users, entrantIds } = await startTournament({ registered: 2 });
    const [final] = (await service.bracket(tournamentId)).matches;
    await service.report(final!.id, users[0]!, entrantIds[0]!);
    await service.confirm(final!.id, users[1]!);

    await expect(service.finalClosure(tournamentId)).resolves.toBe('confirm');
  });

  it('решение организатора', async () => {
    const { service, tournamentId, entrantIds } = await startTournament({ registered: 2 });
    const [final] = (await service.bracket(tournamentId)).matches;
    await service.resolve(final!.id, 'organizer', entrantIds[1]!);

    await expect(service.finalClosure(tournamentId)).resolves.toBe('resolve');
  });

  /** Пропуск в сетке закрывает бот — финалом он не бывает и итог не описывает. */
  it('проходы без игры по пропуску в сетке в расчёт не идут', async () => {
    // Трое в сетке на четверых: у первого сида пропуск, и его проход записывает бот. Если
    // финал никто не закрыл, отвечать нечего — а не «присуждено без игры».
    const { service, tournamentId } = await startTournament({ registered: 3 });

    await expect(service.finalClosure(tournamentId)).resolves.toBeNull();

    await playToEnd(service, tournamentId);
    await expect(service.finalClosure(tournamentId)).resolves.toBe('resolve');
  });
});

describe('ветка матча', () => {
  /** Две ветки на матч — два места для договорённостей: записывается только первая. */
  it('записывается один раз, вторая попытка сообщает, что опоздала', async () => {
    const { service, tournamentId } = await startTournament({ registered: 2 });
    const [match] = (await service.bracket(tournamentId)).matches;

    await expect(service.attachThread(match!.id, 'thread-first')).resolves.toBe(true);
    await expect(service.attachThread(match!.id, 'thread-second')).resolves.toBe(false);
    expect((await service.matchById(match!.id)).threadId).toBe('thread-first');
  });
});

/**
 * Жеребьёвка «случайно» раньше сохранялась и показывалась, но сетка всё равно строилась по
 * силе. Проверяем подстановкой своего случая: сильнейший должен оказаться не первым.
 */
describe('случайная жеребьёвка', () => {
  async function registered(seeding: 'random' | 'rank') {
    const service = createTournamentsService({ db: pg.db });
    guildCounter += 1;
    const tournament = await service.create({
      guildId: `71000000000000${String(guildCounter).padStart(4, '0')}`,
      name: 'Жеребьёвка',
      game: 'dota2',
      format: 'single-elim',
      entryMode: 'solo',
      teamSize: 1,
      maxEntrants: 8,
      seeding,
      bestOf: 1,
      requireVerified: false,
      createdBy: 'organizer',
    });
    await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));
    const ids: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const user = `9${String(guildCounter).padStart(8, '0')}${String(index).padStart(8, '0')}`;
      ids.push((await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`)).id);
      await service.checkIn(tournament.id, user);
    }
    // Сила убывает: первый созданный — сильнейший.
    const strengths = new Map(ids.map((id, index) => [id, 1_000 - index * 100]));
    return { service, tournamentId: tournament.id, ids, strengths };
  }

  it('при случайной сильнейший не обязан быть первым сидом', async () => {
    const { service, tournamentId, ids, strengths } = await registered('random');
    // Кубик выпадает по возрастанию — значит, первым сидом станет последний созданный.
    const rolls = [0.1, 0.2, 0.3, 0.4];
    const view = await service.start(tournamentId, strengths, () => rolls.shift() ?? 0);

    const seedOf = (id: number): number | null => view.entrants.find((entrant) => entrant.id === id)?.seed ?? null;
    expect(seedOf(ids[3]!)).toBe(1);
    expect(seedOf(ids[0]!)).toBe(4);
  });

  it('по силе — сильнейший первый, что бы ни выпало на кубике', async () => {
    const { service, tournamentId, ids, strengths } = await registered('rank');
    const view = await service.start(tournamentId, strengths, () => 0.99);

    expect(view.entrants.find((entrant) => entrant.id === ids[0])?.seed).toBe(1);
  });
});

/**
 * Ручные регистрации, у которых наступило время старта. Турниры суточного автомата сюда не
 * попадают: их стартует сам автомат, и второй старт с другого пути отказывал бы каждую минуту.
 */
describe('ручные регистрации к старту', () => {
  async function inRegistration(closesInMs: number) {
    const service = createTournamentsService({ db: pg.db });
    guildCounter += 1;
    const guildId = `72000000000000${String(guildCounter).padStart(4, '0')}`;
    const tournament = await service.create({
      guildId,
      name: 'Регистрация',
      game: 'dota2',
      format: 'single-elim',
      entryMode: 'solo',
      teamSize: 1,
      maxEntrants: 8,
      seeding: 'rank',
      bestOf: 1,
      requireVerified: false,
      createdBy: 'organizer',
    });
    await service.openRegistration(tournament.id, new Date(Date.now() + closesInMs));
    return { service, guildId, tournamentId: tournament.id };
  }

  it('наступившее время попадает, далёкое — нет', async () => {
    const due = await inRegistration(-60_000);
    const later = await inRegistration(3 * 3_600_000);

    const ids = (await due.service.manualRegistrationsClosingBy(new Date())).map((row) => row.id);

    expect(ids).toContain(due.tournamentId);
    expect(ids).not.toContain(later.tournamentId);
  });

  it('турнир суточного автомата не попадает', async () => {
    const cycleOwned = await inRegistration(-60_000);
    await pg.db.execute(sql`
      insert into tournament_cycles (guild_id, cycle_date, stage, tournament_id)
      values (${cycleOwned.guildId}, current_date, 'registration', ${cycleOwned.tournamentId})
    `);

    const ids = (await cycleOwned.service.manualRegistrationsClosingBy(new Date())).map((row) => row.id);

    expect(ids).not.toContain(cycleOwned.tournamentId);
  });
});

/**
 * Старт — в шину: прогрессия начисляет опыт за участие и выдаёт «Дебют». Раньше события не
 * было, и эти награды не выдавались никогда.
 */
describe('событие о старте', () => {
  it('публикуется со всеми участниками, отметившимися в сетку', async () => {
    const bus = new EventBus(logger);
    const started: Array<{ participantUserIds: string[]; captainUserIds: string[]; entrants: number }> = [];
    bus.on('tournament.started', async (payload) => {
      started.push(payload);
    });

    const { users } = await startTournament({ registered: 4, checkedIn: 3, bus });

    expect(started).toHaveLength(1);
    expect(started[0]?.entrants).toBe(3);
    // Неотметившийся в сетку не попал — и опыта за участие не получает.
    expect(started[0]?.participantUserIds.sort()).toEqual(users.slice(0, 3).sort());
    // Одиночки — не капитаны собранных команд.
    expect(started[0]?.captainUserIds).toEqual([]);
  });

  /** Ручной старт и автостарт по времени в одну минуту: второй откатывается целиком. */
  it('второй старт отказывает и сетку не перестраивает', async () => {
    const bus = new EventBus(logger);
    let events = 0;
    bus.on('tournament.started', async () => {
      events += 1;
    });
    const { service, tournamentId } = await startTournament({ registered: 4, bus });
    const before = (await service.bracket(tournamentId)).matches.length;

    await expect(service.start(tournamentId, new Map())).rejects.toThrow(/не в состоянии регистрации|уже стартовал/);

    expect((await service.bracket(tournamentId)).matches).toHaveLength(before);
    expect(events).toBe(1);
  });
});

describe('одновременный старт', () => {
  it('из двух одновременных стартов проходит ровно один', async () => {
    const service = createTournamentsService({ db: pg.db });
    guildCounter += 1;
    const tournament = await service.create({
      guildId: `75000000000000${String(guildCounter).padStart(4, '0')}`,
      name: 'Гонка стартов',
      game: 'dota2',
      format: 'single-elim',
      entryMode: 'solo',
      teamSize: 1,
      maxEntrants: 8,
      seeding: 'rank',
      bestOf: 1,
      requireVerified: false,
      createdBy: 'organizer',
    });
    await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));
    for (let index = 0; index < 4; index += 1) {
      const user = `76${String(guildCounter).padStart(8, '0')}${String(index).padStart(8, '0')}`;
      await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`);
      await service.checkIn(tournament.id, user);
    }

    const results = await Promise.allSettled([
      service.start(tournament.id, new Map()),
      service.start(tournament.id, new Map()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    // Одна сетка на четверых — три матча, а не шесть.
    expect((await service.bracket(tournament.id)).matches).toHaveLength(3);
  });
});

/**
 * События матча. Витрина и всё, что реагирует на ход вечера, слушают их — значит каждое
 * должно приходить ровно один раз, после того как переход записан, каким бы путём он ни шёл.
 */
describe('события матча', () => {
  function recorder() {
    const bus = new EventBus(logger);
    const seen: Array<{ event: string; matchId?: number; via?: string; finished?: boolean }> = [];
    for (const event of ['match.ready', 'match.reported', 'match.disputed', 'match.confirmed', 'tournament.cancelled'] as const) {
      bus.on(event, async (payload) => {
        seen.push({
          event,
          ...('matchId' in payload ? { matchId: payload.matchId } : {}),
          ...('via' in payload ? { via: payload.via, finished: payload.finished } : {}),
        });
      });
    }
    return { bus, seen };
  }

  it('на старте — «готов» для каждого матча первого круга', async () => {
    const { bus, seen } = recorder();
    const { service, tournamentId } = await startTournament({ registered: 4, bus });

    const firstRound = (await service.bracket(tournamentId)).matches.filter((row) => row.round === 1);
    expect(seen.filter((row) => row.event === 'match.ready').map((row) => row.matchId).sort()).toEqual(
      firstRound.map((row) => row.id).sort(),
    );
  });

  it('пропуск в сетке — «закрыт» с пометкой, что без игры', async () => {
    const { bus, seen } = recorder();
    await startTournament({ registered: 3, bus });

    expect(seen.filter((row) => row.via === 'bye')).toHaveLength(1);
  });

  it('заявка, подтверждение и продвижение — по одному событию, повтор не дублирует', async () => {
    const { bus, seen } = recorder();
    const { service, tournamentId, users, entrantIds } = await startTournament({ registered: 2, bus });
    const [final] = (await service.bracket(tournamentId)).matches;
    seen.length = 0;

    await service.report(final!.id, users[0]!, entrantIds[0]!);
    await expect(service.report(final!.id, users[0]!, entrantIds[0]!)).rejects.toThrow();
    await service.confirm(final!.id, users[1]!);
    await service.settle(final!.id, entrantIds[0]!, 'system', 'resolve', true);

    expect(seen.map((row) => row.event)).toEqual(['match.reported', 'match.confirmed']);
    expect(seen[1]).toMatchObject({ via: 'confirm', finished: true });
  });

  it('следующий матч объявляет себя готовым, когда в нём оба соперника', async () => {
    const { bus, seen } = recorder();
    const { service, tournamentId } = await startTournament({ registered: 4, bus });
    seen.length = 0;

    await playToEnd(service, tournamentId);

    const final = (await service.bracket(tournamentId)).matches.find((row) => row.round === 2);
    expect(seen.filter((row) => row.event === 'match.ready').map((row) => row.matchId)).toEqual([final!.id]);
  });

  it('спор — одно событие', async () => {
    const { bus, seen } = recorder();
    const { service, tournamentId, users, entrantIds } = await startTournament({ registered: 2, bus });
    const [final] = (await service.bracket(tournamentId)).matches;
    await service.report(final!.id, users[0]!, entrantIds[0]!);

    await service.dispute(final!.id, users[1]!);

    expect(seen.filter((row) => row.event === 'match.disputed')).toHaveLength(1);
  });

  it('отмена — одно событие, повторная отмена молчит', async () => {
    const { bus, seen } = recorder();
    const { service, tournamentId } = await startTournament({ registered: 4, bus });

    await service.cancel(tournamentId);
    await service.cancel(tournamentId);

    expect(seen.filter((row) => row.event === 'tournament.cancelled')).toHaveLength(1);
  });
});

/**
 * Ход матча: «На месте», неявка, напоминание, переигровка. Всё держится на CAS-отметках —
 * двойное нажатие и джоба, пришедшая дважды, не должны ни начинать матч дважды, ни звать
 * организатора каждую минуту.
 */
describe('ход матча', () => {
  async function readyMatch(bus?: EventBus) {
    const started = await startTournament({ registered: 2, ...(bus ? { bus } : {}) });
    const [match] = (await started.service.bracket(started.tournamentId)).matches;
    return { ...started, match: match! };
  }

  it('обе стороны на месте — матч начался, и событие одно', async () => {
    const bus = new EventBus(logger);
    let live = 0;
    bus.on('match.live', async () => {
      live += 1;
    });
    const { service, match, users } = await readyMatch(bus);

    const first = await service.markPresent(match.id, users[0]!);
    expect(first).toMatchObject({ side: 'a', started: false, alreadyPresent: false });

    const again = await service.markPresent(match.id, users[0]!);
    expect(again.alreadyPresent).toBe(true);

    const second = await service.markPresent(match.id, users[1]!);
    expect(second).toMatchObject({ side: 'b', started: true });
    expect(second.match.liveAt).not.toBeNull();
    expect(live).toBe(1);
  });

  it('чужой отметиться не может', async () => {
    const { service, match } = await readyMatch();

    await expect(service.markPresent(match.id, '999999999999999999')).rejects.toThrow(/только игрок этого матча/);
  });

  it('по стороне — то же, что по игроку', async () => {
    const { service, match } = await readyMatch();

    await service.markSidePresent(match.id, 'b');
    const result = await service.markSidePresent(match.id, 'a');

    expect(result.started).toBe(true);
  });

  it('неявка: после срока в выборке, после сигнала — нет, после «подождать» — снова через срок', async () => {
    const { service, match } = await readyMatch();
    const announced = new Date(Date.now() - 11 * 60_000);
    await pg.db.update(tournamentMatchesTable).set({ announcedAt: announced }).where(eq(tournamentMatchesTable.id, match.id));
    const now = new Date();

    expect((await service.noShowsDue(now, 10 * 60_000)).map((row) => row.id)).toContain(match.id);
    expect(await service.markEscalated(match.id, now)).toBe(true);
    expect(await service.markEscalated(match.id, now)).toBe(false);
    expect((await service.noShowsDue(now, 10 * 60_000)).map((row) => row.id)).not.toContain(match.id);

    await service.snoozeNoShow(match.id, 5 * 60_000, 10 * 60_000, now);
    expect((await service.noShowsDue(new Date(now.getTime() + 4 * 60_000), 10 * 60_000)).map((row) => row.id)).not.toContain(match.id);
    expect((await service.noShowsDue(new Date(now.getTime() + 6 * 60_000), 10 * 60_000)).map((row) => row.id)).toContain(match.id);
  });

  it('начавшийся матч неявкой не считается', async () => {
    const { service, match } = await readyMatch();
    await pg.db
      .update(tournamentMatchesTable)
      .set({ announcedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(tournamentMatchesTable.id, match.id));
    await service.startMatch(match.id);

    expect((await service.noShowsDue(new Date(), 10 * 60_000)).map((row) => row.id)).not.toContain(match.id);
  });

  it('напоминание сопернику — один раз', async () => {
    const { service, match, users, entrantIds } = await readyMatch();
    await service.report(match.id, users[0]!, entrantIds[0]!);
    const later = new Date(Date.now() + 46 * 60_000);

    expect((await service.confirmRemindersDue(later, 45 * 60_000)).map((row) => row.id)).toContain(match.id);
    expect(await service.markConfirmReminded(match.id)).toBe(true);
    expect((await service.confirmRemindersDue(later, 45 * 60_000)).map((row) => row.id)).not.toContain(match.id);
  });

  it('переигровка возвращает оспоренный матч к началу, без заявки и отметок', async () => {
    const { service, match, users, entrantIds } = await readyMatch();
    await service.markSidePresent(match.id, 'a');
    await service.markSidePresent(match.id, 'b');
    await service.report(match.id, users[0]!, entrantIds[0]!);
    await service.dispute(match.id, users[1]!, 'сыграли не ту карту');
    expect((await service.matchById(match.id)).disputeReason).toBe('сыграли не ту карту');

    const replayed = await service.replay(match.id, 'organizer');

    expect(replayed).toMatchObject({
      state: 'ready',
      reportedWinnerId: null,
      presentAAt: null,
      presentBAt: null,
      liveAt: null,
      disputeReason: null,
    });
    await expect(service.replay(match.id, 'organizer')).rejects.toThrow(/только оспоренный/);
  });
});

/**
 * Исправление закрытого результата по настоящей сетке: прежний победитель уходит из
 * следующего матча, новый встаёт на его место, при двойном устранении меняется и нижняя сетка.
 */
describe('исправление результата', () => {
  it('на выбывание: новый победитель встаёт в следующий матч вместо прежнего', async () => {
    const bus = new EventBus(logger);
    const corrected: number[] = [];
    bus.on('match.corrected', async (payload) => {
      corrected.push(payload.matchId);
    });
    const { service, tournamentId } = await startTournament({ registered: 4, bus });
    const [semi] = (await service.bracket(tournamentId)).matches.filter((row) => row.round === 1);
    const oldWinner = semi!.entrantAId!;
    const newWinner = semi!.entrantBId!;
    await service.resolve(semi!.id, 'organizer', oldWinner);

    await service.correct(semi!.id, 'organizer', newWinner);

    const view = await service.bracket(tournamentId);
    const final = view.matches.find((row) => row.round === 2)!;
    expect([final.entrantAId, final.entrantBId]).toContain(newWinner);
    expect([final.entrantAId, final.entrantBId]).not.toContain(oldWinner);
    expect(view.matches.find((row) => row.id === semi!.id)?.winnerEntrantId).toBe(newWinner);
    expect(corrected).toEqual([semi!.id]);
  });

  it('при двойном устранении меняется и нижняя сетка', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4, format: 'double-elim' });
    const [first] = (await service.bracket(tournamentId)).matches.filter((row) => row.bracket === 'upper' && row.round === 1);
    const a = first!.entrantAId!;
    const b = first!.entrantBId!;
    await service.resolve(first!.id, 'organizer', a);

    await service.correct(first!.id, 'organizer', b);

    const view = await service.bracket(tournamentId);
    const lowerSlots = view.matches.filter((row) => row.bracket === 'lower').flatMap((row) => [row.entrantAId, row.entrantBId]);
    const upperNext = view.matches.filter((row) => row.bracket === 'upper' && row.round === 2).flatMap((row) => [row.entrantAId, row.entrantBId]);
    expect(lowerSlots).toContain(a);
    expect(lowerSlots).not.toContain(b);
    expect(upperNext).toContain(b);
    expect(upperNext).not.toContain(a);
  });

  it('следующий матч уже заявлен — отказ, сетка не тронута', async () => {
    const { service, tournamentId, users, entrantIds } = await startTournament({ registered: 4 });
    const semis = (await service.bracket(tournamentId)).matches.filter((row) => row.round === 1);
    for (const semi of semis) await service.resolve(semi.id, 'organizer', semi.entrantAId!);
    const final = (await service.bracket(tournamentId)).matches.find((row) => row.round === 2)!;
    const reporter = users[entrantIds.indexOf(final.entrantAId!)]!;
    await service.report(final.id, reporter, final.entrantAId!);

    await expect(service.correct(semis[0]!.id, 'organizer', semis[0]!.entrantBId!)).rejects.toThrow(/сыгран или заявлен/);
    expect((await service.matchById(semis[0]!.id)).winnerEntrantId).toBe(semis[0]!.entrantAId);
  });

  it('после финала — отказ: турнир завершён', async () => {
    const { service, tournamentId } = await startTournament({ registered: 2 });
    const [final] = (await service.bracket(tournamentId)).matches;
    await service.resolve(final!.id, 'organizer', final!.entrantAId!);

    await expect(service.correct(final!.id, 'organizer', final!.entrantBId!)).rejects.toThrow(/завершён/);
  });
});

/** Исправления по ревью этапа 3: неявка и напоминания — только у идущих турниров, починка сбоя. */
describe('ход матча после отмены и сбоев', () => {
  it('матч отменённого турнира неявкой не считается', async () => {
    const { service, tournamentId } = await startTournament({ registered: 2 });
    const [match] = (await service.bracket(tournamentId)).matches;
    await pg.db
      .update(tournamentMatchesTable)
      .set({ announcedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(tournamentMatchesTable.id, match!.id));

    await service.cancel(tournamentId);

    expect((await service.noShowsDue(new Date(), 10 * 60_000)).map((row) => row.id)).not.toContain(match!.id);
  });

  it('напоминание о подтверждении — только у идущего турнира', async () => {
    const { service, tournamentId, users, entrantIds } = await startTournament({ registered: 2 });
    const [match] = (await service.bracket(tournamentId)).matches;
    await service.report(match!.id, users[0]!, entrantIds[0]!);
    await service.cancel(tournamentId);

    expect((await service.confirmRemindersDue(new Date(Date.now() + 60 * 60_000), 45 * 60_000)).map((row) => row.id)).not.toContain(
      match!.id,
    );
  });

  /**
   * Прошлая попытка исправления записала победителя и упала до продвижения: слот в следующем
   * матче пуст. Повтор той же команды ведёт победителя дальше, а не отвечает «он и так победитель».
   */
  it('повтор исправления чинит недоведённого победителя', async () => {
    const { service, tournamentId } = await startTournament({ registered: 4 });
    const [semi] = (await service.bracket(tournamentId)).matches.filter((row) => row.round === 1);
    await service.resolve(semi!.id, 'organizer', semi!.entrantAId!);
    const final = (await service.bracket(tournamentId)).matches.find((row) => row.round === 2)!;
    const column = final.entrantAId === semi!.entrantAId ? 'entrantAId' : 'entrantBId';
    // Сбой имитируем руками: победитель уже другой, а в финал он не доведён.
    await pg.db
      .update(tournamentMatchesTable)
      .set({ winnerEntrantId: semi!.entrantBId, [column]: null })
      .where(eq(tournamentMatchesTable.id, semi!.id));
    await pg.db.update(tournamentMatchesTable).set({ [column]: null }).where(eq(tournamentMatchesTable.id, final.id));

    await service.correct(semi!.id, 'organizer', semi!.entrantBId!);

    const repaired = (await service.bracket(tournamentId)).matches.find((row) => row.id === final.id)!;
    expect([repaired.entrantAId, repaired.entrantBId]).toContain(semi!.entrantBId);
  });

  /** Прогнозы на прежнюю пару должны сброситься раньше, чем матч снова станет играбельным. */
  it('исправление объявляет сброс следующего матча до того, как он снова готов', async () => {
    const bus = new EventBus(logger);
    const order: string[] = [];
    bus.on('match.reset', async ({ matchId }) => {
      order.push(`reset:${matchId}`);
    });
    bus.on('match.ready', async ({ matchId }) => {
      order.push(`ready:${matchId}`);
    });
    const { service, tournamentId } = await startTournament({ registered: 4, bus });
    const semis = (await service.bracket(tournamentId)).matches.filter((row) => row.round === 1);
    for (const semi of semis) await service.resolve(semi.id, 'organizer', semi.entrantAId!);
    const final = (await service.bracket(tournamentId)).matches.find((row) => row.round === 2)!;
    order.length = 0;

    await service.correct(semis[0]!.id, 'organizer', semis[0]!.entrantBId!);

    expect(order).toEqual([`reset:${final.id}`, `ready:${final.id}`]);
  });
});
