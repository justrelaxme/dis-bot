import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { RankInfo } from '../providers/provider.js';
import { buildProfileCard, type ProfileEntry } from '../render/profile-card.js';
import type { IdentityDeps } from './link.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
/** Двойной интервал cron-синхронизации: за это время аккаунт обязан был обновиться. */
const STALE_AFTER_MS = 60 * 60 * 1_000;

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
        const isStale = Date.now() - account.updatedAt.getTime() > STALE_AFTER_MS;
        entries.push({ account, ranks, previous, ...(isStale ? { staleSince: account.updatedAt } : {}) });
      }

      const card = buildProfileCard({
        displayName: target.displayName,
        // avatarUrl нельзя присваивать явным undefined (exactOptionalPropertyTypes) —
        // тот же приём условного спреда, что и в providers/steam.ts.
        ...(target.displayAvatarURL() ? { avatarUrl: target.displayAvatarURL() } : {}),
        entries,
      });

      // С IsComponentsV2 нельзя передавать content, embeds, stickers или poll
      // в том же сообщении — только компоненты.
      await interaction.followUp({ components: [card], flags: MessageFlags.IsComponentsV2 });
    },
  };
}
