import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Cooldown } from '../../../core/cooldown.js';
import { describeForUser, UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { IdentityDeps } from './link.js';

/** Значение из спеки: /ranksync доступен раз в 10 минут на пользователя. */
const RANKSYNC_COOLDOWN_MS = 10 * 60 * 1_000;

export function createRankSyncCommand(deps: IdentityDeps & { cooldown: Cooldown }): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder().setName('ranksync').setDescription('Обновить свои ранги сейчас'),

    async execute(interaction, ctx) {
      const userId = interaction.user.id;

      // Сначала проверяем, есть ли вообще что синхронизировать, и только потом тратим
      // кулдаун. Раньше порядок был обратным: игрок без привязок получал совет «начни
      // с /link steam», тут же тратил свою попытку на /ranksync за десять минут, и
      // после первой же успешной привязки слышал «попробуй через 10 минут» — хотя ни
      // разу ничего не синхронизировал. Проверка наличия аккаунтов — чтение из уже
      // открытого соединения с БД и не расходует ничей лимит, поэтому её можно смело
      // делать до cooldown.hit.
      const accounts = await deps.linking.listAccounts(userId);
      if (accounts.length === 0) {
        throw new UserError('У тебя нет привязанных аккаунтов. Начни с `/link steam` или `/link riot`.');
      }

      const verdict = await deps.cooldown.hit(`ranksync:${userId}`, RANKSYNC_COOLDOWN_MS);
      if (!verdict.allowed) {
        const minutes = Math.ceil(verdict.retryAfterMs / 60_000);
        throw new UserError(
          `Ранги обновляются сами каждые полчаса. Вручную можно раз в 10 минут — попробуй через ${minutes} мин.`,
        );
      }

      let updated = 0;
      const problems: string[] = [];

      for (const account of accounts) {
        try {
          const ranks = await deps.rankSync.syncAccount(account);
          if (ranks.length > 0) updated += 1;
        } catch (error) {
          // Сбой одного провайдера не должен лишать пользователя ответа по остальным —
          // но сам сбой и «рангов действительно нет» (пустой список от syncAccount,
          // rank-sync.ts) обязаны выглядеть по-разному. Пустой список — легитимный
          // результат, на котором дальше по цепочке событий (rank.changed → applyRoles)
          // снимаются роли за ранг; сбой провайдера — просто «мы не смогли узнать
          // ранг сейчас», и путать одно с другим для игрока нельзя. describeForUser —
          // та же классификация, что у роутера: ProviderError → «сервис недоступен»,
          // остальное — код инцидента, который логируем сами (до роутера этот сбой
          // отдельного аккаунта не долетает, execute не бросает).
          const described = describeForUser(error);
          if (described.incidentId) {
            ctx.logger.error(
              { err: error, incidentId: described.incidentId, provider: account.provider },
              'не удалось синхронизировать ранг аккаунта по запросу /ranksync',
            );
          }
          problems.push(`${account.provider} — ${described.text}`);
        }
      }

      const tail = problems.length > 0 ? `\nНе ответили:\n${problems.join('\n')}` : '';
      await interaction.followUp({
        content: `Проверено аккаунтов: ${accounts.length}, с рангом: ${updated}.${tail}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
