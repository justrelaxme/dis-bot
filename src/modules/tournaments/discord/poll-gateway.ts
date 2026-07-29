import type { Client } from 'discord.js';
import type { PollGateway, PollState } from '../services/finalizer.js';

export function createDiscordPollGateway(client: Client): PollGateway {
  return {
    async fetchPollState(channelId, messageId): Promise<PollState | null> {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      // isSendable(), а не isTextBased(): последний включает PartialGroupDMChannel,
      // у которого нет .send (см. announce ниже) — используем один и тот же,
      // более узкий предикат в обоих методах гейтвея ради единообразия, тем более
      // что голосования и так создаются только в командах гильдии, где до
      // PartialGroupDMChannel дело никогда не доходит.
      if (!channel || !channel.isSendable()) return null;

      // force: true — без него discord.js мог бы вернуть уже закэшированную копию
      // сообщения (например, с момента, когда мы сами его отправляли) со старыми
      // счётчиками голосов или устаревшим resultsFinalized. Джоба обязана
      // переживать перезапуск процесса — после рестарта кэша нет вообще, а до
      // рестарта он мог отстать от реального состояния голосования в Discord.
      const message = await channel.messages.fetch({ message: messageId, force: true }).catch(() => null);
      const poll = message?.poll;
      if (!poll) return null;

      // answer_id в Discord начинается с 1 и идёт по порядку, в котором варианты
      // были отправлены (тот же порядок, что и наш options) — но Collection не
      // гарантирует порядок ключей после патчей, поэтому сортируем явно.
      const orderedAnswers = [...poll.answers.values()].sort((a, b) => a.id - b.id);

      return {
        finalized: poll.resultsFinalized,
        voteCounts: orderedAnswers.map((answer) => answer.voteCount),
      };
    },

    async announce(channelId, content): Promise<void> {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        throw new Error(`Канал ${channelId} недоступен для отправки объявления итогов голосования.`);
      }
      await channel.send({ content });
    },
  };
}
