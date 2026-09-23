import { describe, expect, it, vi } from 'vitest';
import { createMatchAutocomplete } from '../../../../src/modules/tournaments/discord/autocomplete.js';

/**
 * Подсказки в `/match resolve`. Раньше номер матча искали на сайте, а победителя вписывали буква
 * в букву — и опечатка посреди спора отвечала «нет такого участника».
 */

const entrants = [
  { id: 1, displayName: 'Альфа' },
  { id: 2, displayName: 'Браво' },
  { id: 3, displayName: 'Гамма' },
  { id: 4, displayName: 'Дельта' },
];
const matches = [
  { id: 10, state: 'ready', entrantAId: 1, entrantBId: 2 },
  { id: 11, state: 'disputed', entrantAId: 3, entrantBId: 4 },
];

function interaction(focused: { name: string; value: string }, match: number | null = null, subcommand = 'resolve') {
  const respond = vi.fn(async () => {});
  return {
    respond,
    interaction: {
      isAutocomplete: () => true,
      commandName: 'match',
      guildId: 'g',
      respond,
      options: {
        getFocused: () => focused,
        getSubcommand: () => subcommand,
        getInteger: () => match,
      },
    } as never,
  };
}

const handler = createMatchAutocomplete({
  tournaments: {
    current: vi.fn(async () => ({ id: 7 })),
    matchesForPicker: vi.fn(async () => matches),
    bracket: vi.fn(async () => ({ entrants })),
    matchById: vi.fn(async (id: number) => matches.find((row) => row.id === id)),
  } as never,
});
const ctx = { logger: { warn: vi.fn() } } as never;

describe('подсказки матчей', () => {
  it('спорные матчи — наверху, с именами и состоянием', async () => {
    const { interaction: event, respond } = interaction({ name: 'match', value: '' });

    await handler.handle(ctx, event);

    const [choices] = respond.mock.calls[0] as unknown as [Array<{ name: string; value: number }>];
    expect(choices[0]).toEqual({ name: '№11 · Гамма — Дельта · спор', value: 11 });
    expect(choices[1]?.value).toBe(10);
  });

  it('по набранному номеру', async () => {
    const { interaction: event, respond } = interaction({ name: 'match', value: '10' });

    await handler.handle(ctx, event);

    const [choices] = respond.mock.calls[0] as unknown as [Array<{ value: number }>];
    expect(choices.map((choice) => choice.value)).toEqual([10]);
  });

  it('победитель — только из двух соперников выбранного матча', async () => {
    const { interaction: event, respond } = interaction({ name: 'winner', value: '' }, 11);

    await handler.handle(ctx, event);

    const [choices] = respond.mock.calls[0] as unknown as [Array<{ name: string }>];
    expect(choices.map((choice) => choice.name)).toEqual(['Гамма', 'Дельта']);
  });
});
