import { beforeAll, describe, expect, it } from 'vitest';
import { UserError } from '../../../src/core/errors.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import type { RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const ALICE = '222222222222222222';
const BOB = '333333333333333333';
// Отдельный пользователь для теста replay-защиты: не должен пересекаться по
// состоянию с ALICE/BOB, которые участвуют в других тестах этого файла (таблицы
// чистятся один раз на файл, а не перед каждым тестом — см. tests/helpers/postgres.ts).
const CAROL = '444444444444444444';

const steamAccount = {
  externalId: '76561198000000001',
  displayName: 'alice',
  verificationMethod: 'steam-openid' as const,
};

function rank(tier: string, division: string | null): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division, points: 20, source: 'api', raw: {} };
}

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: '111111111111111111' });
});

describe('LinkingService', () => {
  it('создаёт пользователя идемпотентно', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await expect(service.ensureUser(ALICE)).resolves.toBeUndefined();
  });

  it('привязывает аккаунт и возвращает его id', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);

    const accountId = await service.linkAccount(ALICE, 'steam', steamAccount, true);

    expect(accountId).toBeTypeOf('number');
    const accounts = await service.listAccounts(ALICE);
    expect(accounts[0]?.verifiedAt).not.toBeNull();
  });

  it('заменяет привязку того же провайдера, а не создаёт вторую', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.linkAccount(ALICE, 'steam', steamAccount, true);
    await service.linkAccount(ALICE, 'steam', { ...steamAccount, displayName: 'alice-новая' }, true);

    const accounts = await service.listAccounts(ALICE);
    expect(accounts.filter((a) => a.provider === 'steam')).toHaveLength(1);
    expect(accounts[0]?.displayName).toBe('alice-новая');
  });

  it('отказывает, когда аккаунт уже привязан к другому пользователю', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.ensureUser(BOB);
    await service.linkAccount(ALICE, 'steam', steamAccount, true);

    await expect(service.linkAccount(BOB, 'steam', steamAccount, true)).rejects.toThrow(UserError);
  });

  it('помечает неподтверждённую привязку через verifiedAt = null', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(BOB);
    await service.linkAccount(BOB, 'riot-valorant', { externalId: 'Боб#EUW', displayName: 'Боб#EUW', verificationMethod: 'manual' }, false);

    const accounts = await service.listAccounts(BOB);
    expect(accounts.find((a) => a.provider === 'riot-valorant')?.verifiedAt).toBeNull();
  });

  it('отвязывает аккаунт и сообщает, был ли он', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.linkAccount(ALICE, 'steam', steamAccount, true);

    await expect(service.unlinkAccount(ALICE, 'steam')).resolves.toBe(true);
    await expect(service.unlinkAccount(ALICE, 'steam')).resolves.toBe(false);
  });

  it('выдаёт челлендж и потребляет его один раз', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.openChallenge(ALICE, 'steam', {
      challenge: 'НОНС-1',
      expiresAt: new Date(Date.now() + 60_000),
      payload: { platform: 'euw1' },
    });

    const taken = await service.takeChallenge('НОНС-1');
    expect(taken).toMatchObject({ userId: ALICE, provider: 'steam', payload: { platform: 'euw1' } });
  });

  // Мутационная проверка 1 (одноразовость): брифовский тест выше называется
  // «потребляет его один раз», но фактически ни разу не проверяет, что повторное
  // предъявление того же кода не сработает — он лишь проверяет содержимое ответа
  // на единственный вызов. Без этого теста утечка кода (лог, история браузера,
  // повторный сабмит) позволяла бы предъявить его снова и снова, пока не истекут
  // 15 минут или 5 попыток. Добавлено сверх брифа — см. отчёт.
  it('не даёт предъявить код повторно после того, как привязка по нему завершилась (replay)', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(CAROL);
    await service.openChallenge(CAROL, 'steam', {
      challenge: 'НОНС-РЕПЛЕЙ',
      expiresAt: new Date(Date.now() + 60_000),
      payload: {},
    });

    const taken = await service.takeChallenge('НОНС-РЕПЛЕЙ');
    await service.linkAccount(
      taken.userId,
      'steam',
      { externalId: '76561198000000777', displayName: 'carol', verificationMethod: 'steam-openid' },
      true,
    );

    await expect(service.takeChallenge('НОНС-РЕПЛЕЙ')).rejects.toThrow(UserError);
  });

  it('отказывает по просроченному челленджу', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.openChallenge(ALICE, 'steam', {
      challenge: 'НОНС-СТАРЫЙ',
      expiresAt: new Date(Date.now() - 1_000),
      payload: {},
    });

    await expect(service.takeChallenge('НОНС-СТАРЫЙ')).rejects.toThrow(/истёк/);
  });

  it('отказывает по неизвестному челленджу', async () => {
    const service = createLinkingService({ db: pg.db });
    await expect(service.takeChallenge('ТАКОГО-НЕТ')).rejects.toThrow(UserError);
  });

  it('находит незавершённый челлендж по владельцу и провайдеру', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(BOB);
    await service.openChallenge(BOB, 'riot-lol', {
      challenge: 'КОД-БОБА',
      expiresAt: new Date(Date.now() + 60_000),
      payload: { platform: 'ru' },
    });

    await expect(service.pendingChallenge(BOB, 'riot-lol')).resolves.toMatchObject({
      challenge: 'КОД-БОБА',
      payload: { platform: 'ru' },
    });
  });

  it('не отдаёт просроченный челлендж как незавершённый', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(BOB);
    await service.openChallenge(BOB, 'riot-tft', {
      challenge: 'КОД-ПРОСРОЧЕН',
      expiresAt: new Date(Date.now() - 1_000),
      payload: {},
    });

    await expect(service.pendingChallenge(BOB, 'riot-tft')).resolves.toBeNull();
  });

  it('исчерпывает попытки после пяти неудач', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.openChallenge(ALICE, 'riot-lol', {
      challenge: 'КОД-ПОПЫТКИ',
      expiresAt: new Date(Date.now() + 60_000),
      payload: {},
    });

    for (let i = 0; i < 5; i += 1) {
      await service.takeChallenge('КОД-ПОПЫТКИ');
    }

    await expect(service.takeChallenge('КОД-ПОПЫТКИ')).rejects.toThrow(/попыт/);
  });

  it('отдаёт последний ранг по каждому режиму, а не все снимки', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    const accountId = await service.linkAccount(ALICE, 'riot-lol', { externalId: 'PUUID-1', displayName: 'a#b', verificationMethod: 'manual' }, true);

    await service.saveRank(accountId, rank('GOLD', 'III'));
    await service.saveRank(accountId, rank('GOLD', 'II'));
    await service.saveRank(accountId, { ...rank('SILVER', 'I'), mode: 'flex' });

    const latest = await service.latestRanks(accountId);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.mode === 'solo-duo')?.division).toBe('II');
  });

  it('находит ранг на указанный момент для сравнения за 30 дней', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    const accountId = await service.linkAccount(ALICE, 'riot-tft', { externalId: 'PUUID-2', displayName: 'a#c', verificationMethod: 'manual' }, true);

    await service.saveRank(accountId, { ...rank('BRONZE', 'I'), mode: 'tft-ranked' });
    const past = await service.rankAt(accountId, 'tft-ranked', new Date(Date.now() + 1_000));

    expect(past?.tier).toBe('BRONZE');
  });
});
