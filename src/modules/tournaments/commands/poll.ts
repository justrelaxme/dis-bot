import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { TOURNAMENT_GAMES, TOURNAMENT_GAME_LABELS } from '../games.js';
import type { PollsService } from '../services/polls.js';

const QUESTION_TEXT = 'По какой дисциплине проводим турнир?';

/**
 * Верхняя граница — наш собственный продуктовый предел (неделя на голосование),
 * а не попытка повторить точную цифру ограничения Discord: она не встретилась ни
 * в установленных типах discord.js, ни в его исходниках (только «duration — число
 * часов», без верхней границы), поэтому мы её не копируем на угад. Значение вне
 * реального лимита Discord API само отклонит понятной ошибкой на стороне Discord.
 */
const MAX_DURATION_HOURS = 168;

export function createTournamentPollCommand(deps: { polls: PollsService }): CommandDefinition {
  return {
    // Ответ команды — само голосование, и оно обязано быть публичным. defer без
    // ephemeral: плейсхолдер «бот думает» в канале, который editReply ниже
    // превращает в сообщение с голосованием, без второго, лишнего сообщения.
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('tournament')
      .setDescription('Управление турнирами сервера')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('poll')
          .setDescription('Запустить голосование по дисциплине турнира')
          .addIntegerOption((option) =>
            option
              .setName('hours')
              .setDescription('Длительность голосования в часах')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(MAX_DURATION_HOURS),
          ),
      ),

    async execute(interaction) {
      const guild = interaction.guild;
      if (!guild) {
        throw new UserError('Эта команда работает только на сервере.');
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand !== 'poll') {
        throw new UserError('Неизвестная подкоманда.');
      }

      const hours = interaction.options.getInteger('hours', true);
      // Discord и билдер команды уже ограничивают hours диапазоном [1, MAX_DURATION_HOURS],
      // но execute() — публичная функция, вызываемая и напрямую (юнит-тесты, будущие
      // вызовы), поэтому граница проверяется и здесь, а не только на уровне Discord.
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_DURATION_HOURS) {
        throw new UserError(`Длительность голосования — целое число часов от 1 до ${MAX_DURATION_HOURS}.`);
      }

      const message = await interaction.editReply({
        content: `Голосование по дисциплине турнира запустил(а) <@${interaction.user.id}>.`,
        poll: {
          question: { text: QUESTION_TEXT },
          answers: TOURNAMENT_GAMES.map((game) => ({ text: TOURNAMENT_GAME_LABELS[game] })),
          duration: hours,
          allowMultiselect: false,
        },
      });

      // Срок закрытия берём из ответа Discord (message.poll.expiresAt), а не считаем
      // сами: это тот же момент времени, что покажет игрокам таймер опроса в
      // клиенте, без риска разъехаться с ним из-за рассинхронизации часов или
      // задержки сетевого запроса. Собственный расчёт — только запасной вариант.
      const closesAt = message.poll?.expiresAt ?? new Date(Date.now() + hours * 60 * 60 * 1000);

      await deps.polls.createPoll({
        guildId: guild.id,
        channelId: message.channelId,
        messageId: message.id,
        options: TOURNAMENT_GAMES,
        closesAt,
        createdBy: interaction.user.id,
      });
    },
  };
}
