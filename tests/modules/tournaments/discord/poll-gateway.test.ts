import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createDiscordPollGateway } from '../../../../src/modules/tournaments/discord/poll-gateway.js';

interface FakePollAnswer {
  id: number;
  voteCount: number;
}

function fakeMessageWithPoll(poll: { resultsFinalized: boolean; answers: FakePollAnswer[] } | null) {
  return {
    poll: poll ? { resultsFinalized: poll.resultsFinalized, answers: new Map(poll.answers.map((a) => [a.id, a])) } : null,
  };
}

function fakeClient(channel: unknown) {
  const fetch = vi.fn(async () => channel);
  return { client: { channels: { fetch } } as unknown as Client, fetch };
}

describe('createDiscordPollGateway', () => {
  describe('fetchPollState', () => {
    it('отдаёт голоса в порядке возрастания id ответа, а не в порядке вставки в Map', async () => {
      const messagesFetch = vi.fn(async () =>
        fakeMessageWithPoll({
          resultsFinalized: true,
          // Порядок вставки нарочно перемешан: сортировка по id обязана его выправить,
          // иначе voteCounts привяжется не к тем дисциплинам на стороне финализатора.
          answers: [
            { id: 3, voteCount: 1 },
            { id: 1, voteCount: 9 },
            { id: 2, voteCount: 5 },
          ],
        }),
      );
      const { client } = fakeClient({ isSendable: () => true, messages: { fetch: messagesFetch } });

      const state = await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1');

      expect(state).toEqual({ finalized: true, voteCounts: [9, 5, 1] });
      expect(messagesFetch).toHaveBeenCalledWith({ message: 'msg-1', force: true });
    });

    it('передаёт resultsFinalized как есть, включая false — Discord мог ещё не подвести итоги', async () => {
      const messagesFetch = vi.fn(async () => fakeMessageWithPoll({ resultsFinalized: false, answers: [{ id: 1, voteCount: 0 }] }));
      const { client } = fakeClient({ isSendable: () => true, messages: { fetch: messagesFetch } });

      const state = await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1');

      expect(state?.finalized).toBe(false);
    });

    it('запрашивает сообщение принудительно (force: true), а не из кэша', async () => {
      // Без force: true discord.js может вернуть уже закэшированную копию сообщения
      // (например, с момента, когда мы сами его отправляли) с устаревшими счётчиками
      // голосов или устаревшим resultsFinalized. Джоба обязана переживать перезапуск
      // процесса, после которого кэша нет вовсе, — полагаться на кэш нельзя.
      const messagesFetch = vi.fn<(options: { message: string; force: boolean }) => Promise<ReturnType<typeof fakeMessageWithPoll>>>(
        async () => fakeMessageWithPoll({ resultsFinalized: true, answers: [{ id: 1, voteCount: 1 }] }),
      );
      const { client } = fakeClient({ isSendable: () => true, messages: { fetch: messagesFetch } });

      await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1');

      const call = messagesFetch.mock.calls[0]?.[0];
      expect(call?.force).toBe(true);
    });

    it('возвращает null, если канал не найден', async () => {
      const { client } = fakeClient(null);
      expect(await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1')).toBeNull();
    });

    it('возвращает null, если канал не годится для отправки/чтения (isSendable() === false)', async () => {
      const { client } = fakeClient({ isSendable: () => false });
      expect(await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1')).toBeNull();
    });

    it('возвращает null, если у сообщения нет голосования', async () => {
      const messagesFetch = vi.fn(async () => fakeMessageWithPoll(null));
      const { client } = fakeClient({ isSendable: () => true, messages: { fetch: messagesFetch } });

      expect(await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1')).toBeNull();
    });

    it('возвращает null, если запрос к Discord упал (канал/сообщение удалены, нет доступа и т.п.)', async () => {
      const messagesFetch = vi.fn(async () => {
        throw new Error('Unknown Message');
      });
      const { client } = fakeClient({ isSendable: () => true, messages: { fetch: messagesFetch } });

      expect(await createDiscordPollGateway(client).fetchPollState('chan-1', 'msg-1')).toBeNull();
    });
  });

  describe('announce', () => {
    it('отправляет текстовое сообщение в канал', async () => {
      const send = vi.fn(async () => ({}));
      const { client } = fakeClient({ isSendable: () => true, send });

      await createDiscordPollGateway(client).announce('chan-1', 'Победила Dota 2!');

      expect(send).toHaveBeenCalledWith({ content: 'Победила Dota 2!' });
    });

    it('бросает, если канал недоступен для отправки', async () => {
      const { client } = fakeClient(null);
      await expect(createDiscordPollGateway(client).announce('chan-1', 'текст')).rejects.toThrow();
    });

    it('бросает, если канал не годится для отправки (isSendable() === false)', async () => {
      const { client } = fakeClient({ isSendable: () => false });
      await expect(createDiscordPollGateway(client).announce('chan-1', 'текст')).rejects.toThrow();
    });
  });
});
