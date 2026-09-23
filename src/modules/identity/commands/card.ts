import { and, eq } from 'drizzle-orm';
import { SlashCommandBuilder } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { playerPages } from '../schema.js';

/**
 * `/card` — своя страница игрока на сайте, включается и выключается только самим игроком.
 *
 * Страница `/p/:id` показывает турнирный след: титулы, матчи, место в сезоне, достижения. По
 * умолчанию её нет: связка Discord-аккаунта с игровым — личные данные, и выставлять её без
 * спроса нельзя. Игровые аккаунты и ранги — отдельными переключателями: турнирный след и так
 * виден в сетках, а аккаунт и ранг человек показывает, только если сам захотел.
 *
 * Ответ эфемерный: это настройка, а не объявление.
 */
export function createCardCommand(deps: { db: Database; publicBaseUrl: string }): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('card')
      .setDescription('Своя страница игрока на сайте: включить, выключить, что показывать')
      .addSubcommand((sub) =>
        sub
          .setName('on')
          .setDescription('Открыть страницу: турнирный след, сезон, достижения')
          .addBooleanOption((option) =>
            option.setName('accounts').setDescription('Показывать привязанные игровые аккаунты (ник в игре). По умолчанию — нет'),
          )
          .addBooleanOption((option) =>
            option.setName('ranks').setDescription('Показывать ранги. По умолчанию — да'),
          ),
      )
      .addSubcommand((sub) => sub.setName('off').setDescription('Закрыть страницу — ссылка перестанет открываться')),

    async execute(interaction): Promise<void> {
      const guild = interaction.guild;
      if (!guild) throw new UserError('Эта команда работает только на сервере.');
      const userId = interaction.user.id;
      const url = `${deps.publicBaseUrl}/p/${userId}`;

      if (interaction.options.getSubcommand() === 'off') {
        // Страница проверяет согласие на каждый запрос мимо кэша, так что закрывается сразу.
        await deps.db.delete(playerPages).where(and(eq(playerPages.guildId, guild.id), eq(playerPages.userId, userId)));
        await interaction.editReply({ content: 'Страница закрыта: ссылка на неё больше не открывается.' });
        return;
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      const values = {
        displayName: (member?.displayName ?? interaction.user.displayName).slice(0, 80),
        showAccounts: interaction.options.getBoolean('accounts') ?? false,
        showRanks: interaction.options.getBoolean('ranks') ?? true,
        updatedAt: new Date(),
      };
      await deps.db
        .insert(playerPages)
        .values({ guildId: guild.id, userId, ...values })
        .onConflictDoUpdate({ target: [playerPages.guildId, playerPages.userId], set: values });

      await interaction.editReply({
        content: [
          `Твоя страница: ${url}`,
          `Показывается: турнирный след, сезон, достижения${values.showRanks ? ', ранги' : ''}${values.showAccounts ? ', игровые ники' : ''}.`,
          'Поменять — `/card on` с другими переключателями, закрыть — `/card off`.',
        ].join('\n'),
      });
    },
  };
}
