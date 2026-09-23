import { describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import { createCycleService } from '../../../src/modules/tournaments/services/cycle.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

/**
 * Расписание берёт бюджет и иммуны из пресета. Бюджет Genshin идёт шагами по 0,5 очка, и
 * колонка расписания должна его принять — у пресета и турнира она дробная.
 */
describe('бюджет в расписании', () => {
  it('дробный потолок сохраняется как есть', async () => {
    const cycles = createCycleService({ db: pg.db, logger });

    const saved = await cycles.upsertSchedule('780000000000000001', { costCap: 4.5, immunities: 2 });

    expect(saved.costCap).toBe(4.5);
    expect(saved.immunities).toBe(2);
  });

  it('по умолчанию предлагаются только текущие дисциплины', async () => {
    const cycles = createCycleService({ db: pg.db, logger });

    const saved = await cycles.upsertSchedule('780000000000000002', {});

    expect(saved.games).toEqual(['dota2', 'valorant', 'genshin']);
  });
});
