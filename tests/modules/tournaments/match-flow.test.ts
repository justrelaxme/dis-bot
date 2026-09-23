import { describe, expect, it, vi } from 'vitest';
import { matchCardButtons, matchCardText, type MatchCard } from '../../../src/modules/tournaments/discord/match-card.js';
import { runMatchFlow } from '../../../src/modules/tournaments/discord/match-flow.js';

/**
 * Карточка «матч готов» и джоба хода матча. Карточка — единственное место, где у матча есть
 * кнопка «На месте», поэтому проверяется, что в ней есть всё нужное для начала и что после
 * начала кнопки больше нет.
 */

const card = (over: Partial<MatchCard> = {}): MatchCard => ({
  matchId: 12,
  a: { name: 'Альфа', members: ['u1', 'u2'], voiceChannelId: 'v-a', present: false },
  b: { name: 'Браво', members: ['u3'], voiceChannelId: 'v-b', present: true },
  draftUrl: 'https://bot.example/draft/12',
  live: false,
  ...over,
});

describe('карточка матча', () => {
  it('зовёт обе стороны, даёт голосовые и драфт', () => {
    const text = matchCardText(card());

    expect(text).toContain('Матч №12 · Альфа — Браво');
    expect(text).toContain('<@u1> <@u2>');
    expect(text).toContain('<@u3>');
    expect(text).toContain('<#v-a> · <#v-b>');
    expect(text).toContain('https://bot.example/draft/12');
  });

  it('видно, кто уже на месте', () => {
    const text = matchCardText(card());

    expect(text).toContain('⏳ Альфа · ✅ Браво');
  });

  it('пока матч не начался — кнопка «На месте»', () => {
    const [row] = matchCardButtons(card());

    expect(row?.toJSON().components[0]).toMatchObject({ custom_id: 'mp:12', label: 'На месте' });
  });

  it('после начала кнопки нет, а текст говорит, что делать дальше', () => {
    const live = card({ live: true });

    expect(matchCardButtons(live)).toEqual([]);
    expect(matchCardText(live)).toContain('/match report');
  });

  it('без драфта о таймере драфта не говорит', () => {
    expect(matchCardText(card({ draftUrl: null }))).not.toContain('таймер драфта');
  });
});

describe('джоба хода матча', () => {
  function depsWith(options: { escalateWins: boolean }) {
    const sent: string[] = [];
    const channel = {
      isSendable: () => true,
      send: vi.fn(async (payload: { content: string }) => {
        sent.push(payload.content);
      }),
    };
    const guild = {
      id: 'g',
      ownerId: 'owner',
      channels: { fetch: vi.fn(async () => channel) },
      fetchOwner: vi.fn(async () => null),
    };
    const match = {
      id: 12,
      tournamentId: 7,
      entrantAId: 1,
      entrantBId: 2,
      presentAAt: new Date(),
      presentBAt: null,
      threadId: 'thread-12',
    };
    const tournaments = {
      noShowsDue: vi.fn(async () => [match]),
      markEscalated: vi.fn(async () => options.escalateWins),
      byId: vi.fn(async () => ({ id: 7, guildId: 'g', name: 'Кубок', announceChannelId: 'announce' })),
      bracket: vi.fn(async () => ({ entrants: [{ id: 1, displayName: 'Альфа' }, { id: 2, displayName: 'Браво' }] })),
      confirmRemindersDue: vi.fn(async () => []),
    };
    const deps = {
      tournaments,
      staff: { settings: { get: vi.fn(async () => ({ staffChannelId: 'staff', organizerRoleId: 'org' })) }, logger: { warn: vi.fn(), error: vi.fn() } },
    };
    const client = { guilds: { cache: { get: () => guild } } };
    return { deps: deps as never, client: client as never, sent };
  }

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  it('неявку относит в штаб: кто на месте, кто нет', async () => {
    const { deps, client, sent } = depsWith({ escalateWins: true });

    await runMatchFlow(deps, client, logger, new Date());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Неявка в матче №12');
    expect(sent[0]).toContain('Альфа — ✅ на месте');
    expect(sent[0]).toContain('Браво — ⏳ нет');
  });

  /** Джоба тикает раз в минуту: сигнал, отметку о котором занял другой проход, не шлётся. */
  it('второй раз о той же неявке не зовёт', async () => {
    const { deps, client, sent } = depsWith({ escalateWins: false });

    await runMatchFlow(deps, client, logger, new Date());

    expect(sent).toEqual([]);
  });
});

/**
 * Кнопки сигнала о неявке живут дольше самой неявки: опоздавшие пришли и сыграли, а старая
 * «Техпобеда» закрыла бы сыгранный матч как неявку.
 */
describe('кнопки организатора при неявке', () => {
  it('у начавшегося матча решение не принимается, кнопки убираются', async () => {
    const { createMatchFlowHandler } = await import('../../../src/modules/tournaments/discord/match-flow.js');
    const walkover = vi.fn();
    const update = vi.fn(async () => {});
    const handler = createMatchFlowHandler({
      tournaments: {
        matchById: vi.fn(async () => ({ id: 12, tournamentId: 7, state: 'ready', liveAt: new Date() })),
        walkover,
      },
      staff: { settings: { get: vi.fn(async () => null) }, logger: { warn: vi.fn(), error: vi.fn() } },
    } as never);
    const interaction = {
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'nw:12:1',
      guild: { id: 'g' },
      member: { permissions: { has: () => true }, roles: [] },
      user: { id: 'org' },
      message: { content: 'Неявка' },
      update,
    };

    await handler.handle({ logger: { error: vi.fn() } } as never, interaction as never);

    expect(walkover).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
});
