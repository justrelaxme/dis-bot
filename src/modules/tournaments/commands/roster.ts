import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { TournamentsService } from '../services/tournaments.js';

/**
 * `/roster` — ссылка игроку на его собственный состав.
 *
 * Отдельной командой, а не подкомандой `/tournament`, по простой причине: у `/tournament` стоит
 * право «Управление сервером», и это верно — она про настройки вечера. А заявку собирает
 * участник, у которого такого права нет и быть не должно.
 *
 * Ответ эфемерный и останется таким: ссылка — это и есть право менять свою заявку, а сообщение
 * в канале отдало бы его всем, кто это сообщение видит.
 */
export function createRosterCommand(deps: {
  tournaments: TournamentsService;
  grants: { issue(input: { guildId: string; userId: string; scope: 'roster' }): Promise<{ token: string; expiresAt: Date }> };
  publicBaseUrl: string;
}): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('roster')
      .setDescription('Собрать свой состав на турнир по Genshin: персонажи, оружие и бюджет'),

    async execute(interaction): Promise<void> {
      const guildId = interaction.guildId;
      if (!guildId) throw new UserError('Эта команда работает только на сервере.');

      // Проверяем турнир до выдачи ссылки: открывать страницу, которая сразу скажет «турнира
      // нет», значит тратить человеку два действия вместо одного.
      const tournament = await deps.tournaments.current(guildId);
      if (!tournament) {
        throw new UserError('Сейчас нет идущего турнира — заявлять состав некуда.');
      }
      if (tournament.game !== 'genshin') {
        throw new UserError(
          'Заявка состава бывает только у турниров по Genshin: в остальных дисциплинах бот не знает, что у тебя есть.',
        );
      }

      const grant = await deps.grants.issue({ guildId, userId: interaction.user.id, scope: 'roster' });
      const cap = tournament.costCap;

      await interaction.followUp({
        content: [
          `## Твой состав на «${tournament.name}»`,
          `${deps.publicBaseUrl}/roster/${grant.token}`,
          '',
          cap === null
            ? 'Потолка стоимости у этого турнира нет — бери кого хочешь, восемь на этаж.'
            : `Уложиться надо в **${cap}** очков. Четырёхзвёздочные бесплатны совсем, лимитированный C0 стоит 1 и каждое созвездие добавляет ещё 1, его сигнатурное оружие R1 — тоже 1.`,
          '',
          `**Ссылка личная и действует до <t:${Math.floor(grant.expiresAt.getTime() / 1_000)}:t>.** Кто её откроет, тот и меняет твою заявку — не пересылай. Новая ссылка гасит эту.`,
          'Состав читается из твоей Летописи HoYoLAB. Если страница скажет, что Летопись закрыта, открой её: HoYoLAB → Летопись → шестерёнка → сделать публичной.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
