import type { Logger } from '../../../core/logger.js';
import { determineOutcome, renderOutcomeMessage } from '../outcome.js';
import type { TournamentGame } from '../schema.js';
import type { PollsService, TournamentPollRow } from './polls.js';

export interface PollState {
  finalized: boolean;
  /** Число голосов по каждому варианту — в том же порядке, что options голосования. */
  voteCounts: readonly number[];
}

export interface PollGateway {
  /** null — сообщение или канал недоступны (удалены, бот потерял доступ и т.п.). */
  fetchPollState(channelId: string, messageId: string): Promise<PollState | null>;
  /** Отправляет объявление итога в канал. Бросает при сбое Discord. */
  announce(channelId: string, content: string): Promise<void>;
}

export interface FinalizeSummary {
  finalized: number;
  pending: number;
  failed: number;
}

export interface PollFinalizer {
  finalizeDue(limit: number): Promise<FinalizeSummary>;
}

type OneOutcome = 'finalized' | 'pending' | 'failed';

export function createPollFinalizer(deps: { polls: PollsService; gateway: PollGateway; logger: Logger }): PollFinalizer {
  const { polls, gateway, logger } = deps;

  async function finalizeOne(poll: TournamentPollRow): Promise<OneOutcome> {
    const state = await gateway.fetchPollState(poll.channelId, poll.messageId);

    if (!state) {
      logger.warn(
        { pollId: poll.id, channelId: poll.channelId, messageId: poll.messageId },
        'сообщение голосования недоступно в Discord — пробую в следующий прогон',
      );
      return 'pending';
    }

    // Discord финализирует итоги не мгновенно после истечения срока. `finalized:
    // false` здесь означает «ещё не готово», а не «нулевые голоса» — ждём
    // следующего прогона джобы, а не считаем это результатом.
    if (!state.finalized) {
      return 'pending';
    }

    const tally = poll.options.map((game, index) => ({ game, voteCount: state.voteCounts[index] ?? 0 }));
    const outcome = determineOutcome(tally);
    const winnerGame: TournamentGame | null = outcome.kind === 'winner' ? outcome.game : null;

    // Порядок обязателен и это не случайность: сперва claim (CAS по finalized_at
    // IS NULL внутри polls.claimOutcome), потом отправка в Discord. Конкурентный
    // прогон (вторая реплика, перезапуск процесса, наложение джоб) получит на этом
    // же CAS пустой результат и не отправит второе объявление — гонка закрывается
    // здесь, на границе перед отправкой, а не после неё. Если бы порядок был
    // обратным (сперва отправить, потом застолбить), два конкурентных прогона оба
    // прошли бы проверку «ещё не объявлено», оба отправили бы сообщение в Discord,
    // и только затем один из двух CAS отбился бы — поздно, сообщение уже задвоено.
    const claimed = await polls.claimOutcome(poll.id, winnerGame);
    if (!claimed) {
      // Кто-то другой уже застолбил (и, предположительно, уже объявил) это
      // голосование. Наша работа с ним окончена, поэтому это 'finalized', а не
      // 'pending' — но announce вызывать нельзя ни в коем случае.
      return 'finalized';
    }

    try {
      await gateway.announce(poll.channelId, renderOutcomeMessage(outcome));
    } catch (error) {
      // Discord отказал уже ПОСЛЕ того, как мы застолбили finalized_at. Откатываем
      // claim: иначе итог зафиксирован в БД, но никто его не увидел, и это уже не
      // исправить — джоба больше не подберёт это голосование (findDue ищет
      // finalizedAt IS NULL). Следующий прогон переоценит голосование заново.
      logger.error({ err: error, pollId: poll.id }, 'не удалось объявить итог голосования — откатываю финализацию');
      await polls.revertClaim(poll.id);
      return 'failed';
    }

    return 'finalized';
  }

  return {
    async finalizeDue(limit): Promise<FinalizeSummary> {
      const due = await polls.findDue(new Date(), limit);
      const summary: FinalizeSummary = { finalized: 0, pending: 0, failed: 0 };

      for (const poll of due) {
        let outcome: OneOutcome;
        try {
          outcome = await finalizeOne(poll);
        } catch (error) {
          // Один сбойный поллинг не должен обрывать остальные голосования пачки.
          logger.error({ err: error, pollId: poll.id }, 'обработка голосования упала');
          outcome = 'failed';
        }
        summary[outcome] += 1;
      }

      logger.info({ ...summary, size: due.length }, 'проверка голосований завершена');
      return summary;
    },
  };
}
