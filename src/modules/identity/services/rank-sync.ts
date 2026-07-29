import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { Logger } from '../../../core/logger.js';
import { canFetchRank, type GameProvider, type RankInfo } from '../providers/provider.js';
import { hasRankChanged } from '../ranks/compare.js';
import { gameAccounts, type ProviderId } from '../schema.js';
import type { GameAccountRow, LinkingService } from './linking.js';

export interface RankSyncDeps {
  db: Database;
  linking: LinkingService;
  providers: Map<ProviderId, GameProvider>;
  bus: EventBus;
  logger: Logger;
}

export interface RankSyncService {
  syncAccount(account: GameAccountRow): Promise<RankInfo[]>;
  syncBatch(limit: number): Promise<{ synced: number; failed: number }>;
}

export function createRankSyncService(deps: RankSyncDeps): RankSyncService {
  const { db, linking, providers, bus, logger } = deps;

  // Общая точка обновления метки времени: используется на пути «нечего опрашивать»,
  // на пути успеха и на пути сбоя (syncBatch) — чтобы все три места двигали updatedAt
  // одинаково и не расходились между собой.
  async function touch(accountId: number): Promise<void> {
    await db.update(gameAccounts).set({ updatedAt: new Date() }).where(eq(gameAccounts.id, accountId));
  }

  async function syncAccount(account: GameAccountRow): Promise<RankInfo[]> {
    const provider = providers.get(account.provider);
    // canFetchRank — обычный boolean, не type predicate: он не сужает необязательный
    // provider.fetchRank. Сужаем через локальную переменную, без "!".
    const fetchRank = provider?.fetchRank;
    if (!provider || !canFetchRank(provider) || !fetchRank) {
      // Ручной ранг обновляет сам пользователь, планировщику здесь нечего опрашивать.
      // Метка времени всё равно двигается: без этого аккаунт без fetchRank (ручной
      // ранг или провайдер, которого нет в реестре) навсегда останется в голове
      // очереди syncBatch (сортировка по updatedAt) и будет тихо монополизировать
      // каждую следующую пачку — без единой ошибки в логе.
      await touch(account.id);
      return [];
    }

    // Если провайдер упал (таймаут, не-2xx, негодное тело, открытый breaker — всё это
    // ProviderError), ошибка обязана пробрасываться отсюда как есть. Подмена её на
    // пустой список была бы неотличима от «рангов действительно нет», а именно на
    // пустом списке ролевая система снимает роли за ранг — один сбой провайдера
    // не должен срывать роли со всего сервера. Обработка такого сбоя (счётчик
    // failed, продолжение пачки) — забота syncBatch, а не этой функции.
    const fresh = await fetchRank(account.externalId, account.region ?? undefined);
    const previous = await linking.latestRanks(account.id);

    for (const rank of fresh) {
      const before = previous.find((r) => r.mode === rank.mode) ?? null;
      if (!hasRankChanged(before, rank)) continue;

      await linking.saveRank(account.id, rank);
      await bus.emit('rank.changed', {
        userId: account.userId,
        provider: account.provider,
        mode: rank.mode,
        previous: before ? { tier: before.tier, division: before.division } : null,
        current: { tier: rank.tier, division: rank.division },
      });
    }

    // Находка 3 итогового ревью: если мы дошли сюда, fresh — это честный ответ
    // провайдера (сбой пробрасывается выше и сюда не доходит, см. комментарий выше).
    // Отсутствие в fresh режима, который раньше отслеживался (previous), означает,
    // что ранга для этого режима больше нет — сброс сезона, деранк ниже отслеживаемого
    // порога или игрок закрыл профиль приватностью. Без явного снимка с tier: null
    // latestRanks вечно возвращал бы последний ненулевой снимок, и applyRoles никогда
    // не увидел бы повода снять роль — она осталась бы навсегда, даже пережив сброс
    // сезона у всех игроков разом. Схема рангов уже допускает tier: null (это штатное
    // «ранга нет»), а resolveDesiredRoles ранги без тира и так пропускает — новый
    // механизм снятия ролей изобретать не нужно, только доставить правду до него.
    const freshModes = new Set(fresh.map((r) => r.mode));
    for (const prev of previous) {
      if (freshModes.has(prev.mode)) continue;

      const lost: RankInfo = {
        mode: prev.mode,
        scale: prev.scale,
        tier: null,
        division: null,
        points: null,
        source: 'api',
        raw: {},
      };
      // Идемпотентность: если для режима и так уже был null (прошлый прогон уже его
      // зафиксировал), новый снимок не пишем — иначе rank_snapshots распухала бы на
      // каждый прогон синхронизации, пока у игрока нет рангов.
      if (!hasRankChanged(prev, lost)) continue;

      await linking.saveRank(account.id, lost);
      await bus.emit('rank.changed', {
        userId: account.userId,
        provider: account.provider,
        mode: prev.mode,
        previous: { tier: prev.tier, division: prev.division },
        current: { tier: null, division: null },
      });
    }

    // Даже когда ранг не изменился, отметка времени обновляется: иначе один и тот же
    // аккаунт навсегда останется первым в очереди пачки (сортировка по updatedAt).
    await touch(account.id);

    return fresh;
  }

  async function syncBatch(limit: number): Promise<{ synced: number; failed: number }> {
    const batch = await db.select().from(gameAccounts).orderBy(asc(gameAccounts.updatedAt)).limit(limit);

    let synced = 0;
    let failed = 0;

    for (const account of batch) {
      try {
        await syncAccount(account);
        synced += 1;
      } catch (error) {
        // Один сбойный аккаунт не должен обрывать пачку — считаем его явно упавшим
        // (failed), а не «синхронизированным без рангов».
        failed += 1;
        logger.warn(
          { accountId: account.id, provider: account.provider, err: error },
          'не удалось синхронизировать ранг аккаунта',
        );
        // Отметка времени двигается и при сбое: иначе постоянно падающий аккаунт
        // (просроченный ключ, заблокированный профиль) навсегда займёт голову очереди
        // и будет монополизировать каждую следующую пачку.
        await touch(account.id);
      }
    }

    logger.info({ synced, failed, size: batch.length }, 'пачка синхронизации рангов обработана');
    return { synced, failed };
  }

  return { syncAccount, syncBatch };
}
