import { SlashCommandBuilder } from 'discord.js';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import { createProgressionService } from '../progression/service.js';
import { createTournamentsService } from '../tournaments/services/tournaments.js';
import { accuracy, BASE_REWARD, MAX_MULTIPLIER } from './payout.js';
import { createPredictionsService } from './service.js';

/**
 * Прогнозы на матчи: зритель называет победителя и получает монеты, если угадал.
 *
 * Зачем это вообще нужно. Вечер турнира интересен восьми командам и скучен всем остальным:
 * смотреть чужой матч без ставки в нём нечего. Прогноз даёт эту ставку, не требуя играть, — и
 * именно поэтому он бесплатный. Внесение монет означало бы путь списания, возможность уйти в
 * минус и гонку между двумя ставками на один баланс: три новых способа сломаться ради
 * механики, которой на игровом сервере хватает и без денег.
 *
 * Начисление идёт джобой, а не в момент закрытия матча. Матч закрывается двумя путями —
 * кнопкой соперника и молчанием, — и начисление, живущее в одном из них, во втором не
 * сработало бы. Та же причина, по которой в джобу переехала уборка комнат.
 */

/** Раз в пять минут: награда не срочная, а лишние запросы к базе ни к чему. */
const SETTLE_CRON = '*/5 * * * *';
const SETTLE_BATCH = 50;
const BOARD_LIMIT = 10;

export interface PredictionsModuleDeps {
  db: Database;
  logger: Logger;
}

export function createPredictionsModule(deps: PredictionsModuleDeps): BotModule {
  const progression = createProgressionService({ db: deps.db });
  const tournaments = createTournamentsService({ db: deps.db });
  const predictions = createPredictionsService({
    db: deps.db,
    grantCoins: (guildId, userId, coins, reason) =>
      progression.grantCoins(guildId, userId, coins, reason),
  });

  return {
    name: 'predictions',

    commands: [
      {
        defer: { ephemeral: true },
        builder: new SlashCommandBuilder()
          .setName('predict')
          .setDescription('Прогноз на матч турнира: угадай победителя и получи монеты')
          .addSubcommand((sub) =>
            sub
              .setName('match')
              .setDescription('Назвать победителя матча')
              .addIntegerOption((option) =>
                option.setName('match').setDescription('Номер матча').setRequired(true).setMinValue(1),
              )
              .addStringOption((option) =>
                option
                  .setName('side')
                  .setDescription('Кто победит')
                  .setRequired(true)
                  .addChoices({ name: 'Первый в паре', value: 'a' }, { name: 'Второй в паре', value: 'b' }),
              ),
          )
          .addSubcommand((sub) =>
            sub.setName('mine').setDescription('Мои прогнозы по идущему турниру'),
          )
          .addSubcommand((sub) =>
            sub.setName('board').setDescription('Кто угадывает лучше всех'),
          ),

        async execute(interaction): Promise<void> {
          const guild = interaction.guild;
          if (!guild) throw new UserError('Эта команда работает только на сервере.');
          const subcommand = interaction.options.getSubcommand();

          if (subcommand === 'board') {
            const board = await predictions.standings(guild.id, BOARD_LIMIT);
            if (board.length === 0) {
              await interaction.editReply({
                content: [
                  'Пока никто не угадывал.',
                  `Прогноз бесплатный: назови победителя матча командой \`/predict match\`, и если угадаешь — получишь монеты. Чем меньше людей назвали тот же исход, тем больше награда (до ${MAX_MULTIPLIER} раз от базовых ${BASE_REWARD}).`,
                ].join('\n'),
              });
              return;
            }

            await interaction.editReply({
              content: [
                '## Прогнозисты сервера',
                ...board.map(
                  (row, index) =>
                    `**${index + 1}.** <@${row.userId}> — ${row.coins} монет, угадал ${row.correct} из ${row.total} (${accuracy(row.correct, row.total)}%)`,
                ),
              ].join('\n'),
            });
            return;
          }

          const tournament = await tournaments.current(guild.id);
          if (!tournament) throw new UserError('Сейчас на сервере нет турнира.');

          if (subcommand === 'mine') {
            const mine = await predictions.mine(tournament.id, interaction.user.id);
            await interaction.editReply({
              content:
                mine.length === 0
                  ? 'По этому турниру ты пока ничего не прогнозировал. Матчи и их номера — в сетке.'
                  : [
                      `**${tournament.name}** — твои прогнозы:`,
                      ...mine.map((row) => `• Матч №${row.matchId}: **${row.team}**`),
                    ].join('\n'),
            });
            return;
          }

          const matchId = interaction.options.getInteger('match', true);
          const side = interaction.options.getString('side', true);
          const match = await tournaments.matchById(matchId);
          if (match.tournamentId !== tournament.id) {
            throw new UserError('Этот матч не из идущего турнира.');
          }

          const entrantId = side === 'a' ? match.entrantAId : match.entrantBId;
          if (entrantId === null) throw new UserError('В этом матче ещё не известен этот соперник.');

          await predictions.predict(matchId, guild.id, interaction.user.id, entrantId);
          const view = await tournaments.bracket(tournament.id);
          const nameOf = (id: number | null): string =>
            view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';

          const votes = await predictions.tally(matchId);
          const total = votes.reduce((sum, row) => sum + row.votes, 0);
          const same = votes.find((row) => row.entrantId === entrantId)?.votes ?? 1;

          await interaction.editReply({
            content: [
              `Прогноз принят: матч №${matchId}, победит **${nameOf(entrantId)}**.`,
              total > 1
                ? `Так же считают ${same - 1} из ${total - 1} остальных. Чем меньше угадавших, тем больше награда.`
                : 'Ты первый по этому матчу.',
              'Поменять прогноз нельзя — иначе можно было бы передумать, увидев результат.',
            ].join('\n'),
          });
        },
      },
    ],

    jobs: [
      {
        name: 'predictions:settle',
        cron: SETTLE_CRON,
        async run(ctx): Promise<void> {
          const settled = await predictions.settleDue(SETTLE_BATCH);
          if (settled.matches > 0) {
            ctx.logger.info(settled, 'прогнозы по закрытым матчам рассчитаны');
          }
        },
      },
    ],
  };
}
