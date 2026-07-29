import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Cooldown } from '../../../core/cooldown.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { IdentityDeps } from './link.js';

/** Значение из спеки: /ranksync доступен раз в 10 минут на пользователя. */
const RANKSYNC_COOLDOWN_MS = 10 * 60 * 1_000;

export function createRankSyncCommand(deps: IdentityDeps & { cooldown: Cooldown }): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder().setName('ranksync').setDescription('Обновить свои ранги сейчас'),

    async execute(interaction) {
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
        } catch {
          // Сбой одного провайдера не должен лишать пользователя ответа по остальным.
          problems.push(account.provider);
        }
      }

      const tail = problems.length > 0 ? `\nНе ответили: ${problems.join(', ')}.` : '';
      await interaction.followUp({
        content: `Проверено аккаунтов: ${accounts.length}, с рангом: ${updated}.${tail}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
