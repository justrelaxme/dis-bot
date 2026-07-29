import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { RankInfo } from '../providers/provider.js';
import type { CachedGameProvider } from '../providers/with-cache.js';
import { buildProfileCard, type ProfileEntry } from '../render/profile-card.js';
import type { GameAccountRow } from '../services/linking.js';
import type { IdentityDeps } from './link.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Настоящая свежесть ранга — из кэша, а не из gameAccounts.updatedAt. Эту метку
 * двигает rank-sync на каждой попытке синхронизации, включая провальную (иначе
 * сбойный аккаунт навсегда занял бы голову очереди syncBatch, отсортированной по
 * updatedAt) — она отвечает «когда пытались», а не «когда получили», и поэтому не
 * может служить признаком устаревания: при затяжном сбое провайдера updatedAt всё
 * равно остаётся свежим, а при большой очереди — устаревшим у аккаунта, до
 * которого просто не дошла очередь, хотя сервис в порядке.
 *
 * Провайдеры реестра всегда обёрнуты withCache (см. providers/index.ts), поэтому
 * приведение типа ниже безопасно: rankFreshness либо есть (провайдер с авто-рангом),
 * либо undefined — точно как fetchRank у исходного провайдера. Если инвариант вдруг
 * нарушится, optional chaining просто не даст отметки, а не бросит исключение.
 */
async function rankStaleSince(deps: IdentityDeps, account: GameAccountRow): Promise<Date | undefined> {
  const provider = deps.providers.get(account.provider) as CachedGameProvider | undefined;
  const freshness = await provider?.rankFreshness?.(account.externalId, account.region ?? undefined);
  return freshness?.stale ? freshness.storedAt : undefined;
}

export function createProfileCommand(deps: IdentityDeps): CommandDefinition {
  return {
    // Читает БД (и латентность на неё непредсказуема), поэтому объявляет defer —
    // окно ответа Discord 3 секунды. Не эфемерно: профиль — это то, чем игрок
    // обычно хочет поделиться в канале, а не спрятать только для себя.
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Показать игровой профиль')
      .addUserOption((option) => option.setName('user').setDescription('Чей профиль показать').setRequired(false)),

    async execute(interaction) {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const accounts = await deps.linking.listAccounts(target.id);
      const since = new Date(Date.now() - THIRTY_DAYS_MS);

      const entries: ProfileEntry[] = [];
      for (const account of accounts) {
        const ranks = await deps.linking.latestRanks(account.id);
        const previous = new Map<string, RankInfo | null>();
        for (const rank of ranks) {
          previous.set(rank.mode, await deps.linking.rankAt(account.id, rank.mode, since));
        }
        const staleSince = await rankStaleSince(deps, account);
        entries.push({ account, ranks, previous, ...(staleSince ? { staleSince } : {}) });
      }

      const card = buildProfileCard({ displayName: target.displayName, entries });

      // С IsComponentsV2 нельзя передавать content, embeds, stickers или poll
      // в том же сообщении — только компоненты.
      await interaction.followUp({ components: [card], flags: MessageFlags.IsComponentsV2 });
    },
  };
}
