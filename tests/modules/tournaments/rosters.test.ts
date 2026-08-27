import { describe, expect, it } from 'vitest';
import { UserError } from '../../../src/core/errors.js';
import { buildRoster, entryOf } from '../../../src/modules/tournaments/services/rosters.js';

/**
 * Правила заявки. Главное здесь — что потолок это правило, а не подсказка: страница считает то
 * же самое и не даёт нажать «Заявить» при превышении, но заявка, пришедшая мимо неё, обязана
 * упереться в тот же предел.
 */

/** Ху Тао — лимитированная пятизвёздочная: C0 стоит 1 очко. */
const HUTAO = '10000046';
/** Фишль — четырёхзвёздочная: бесплатна при любом созвездии. */
const FISCHL = '10000031';

const owned = [
  {
    id: HUTAO,
    name: 'Ху Тао',
    rarity: 5,
    constellation: 1,
    weapon: { name: 'Нефритовый секач', rarity: 5, refinement: 1 },
    sets: [
      { name: 'Багровая ведьма пламени', pieces: 4 },
      { name: 'Тень Шимэнава', pieces: 1 },
    ],
  },
  { id: FISCHL, name: 'Фишль', rarity: 4, constellation: 6, sets: [] },
  { id: '10000003', name: 'Джинн', rarity: 5, constellation: 0, sets: [] },
];

const submission = (over: Partial<Parameters<typeof buildRoster>[0]> = {}): Parameters<typeof buildRoster>[0] => ({
  tournamentId: 1,
  userId: 'user-1',
  externalId: '700000001',
  characterIds: [HUTAO],
  cap: null,
  owned,
  ...over,
});

describe('персонаж в заявке', () => {
  it('несёт сборку и посчитанную цену', () => {
    const entry = entryOf(owned[0] as never);

    // C1 лимитированной — 2 очка, её сигнатурка R1 — ещё 1.
    expect(entry).toMatchObject({ id: HUTAO, constellation: 1, cost: 3 });
    expect(entry.weapon).toEqual({ name: 'Нефритовый секач', rarity: 5, refinement: 1 });
  });

  /** «4× Багровая ведьма» — то, как о сборке говорят. Одиночный предмет в это не входит. */
  it('комплекты сводятся в строку, а одиночные предметы отбрасываются', () => {
    expect(entryOf(owned[0] as never).sets).toBe('4× Багровая ведьма пламени');
  });

  it('без комплектов строки нет вовсе, а не пустая', () => {
    expect(entryOf(owned[1] as never).sets).toBeUndefined();
  });
});

describe('сборка заявки', () => {
  it('считает сумму по выбранным', () => {
    const result = buildRoster(submission({ characterIds: [HUTAO, FISCHL] }));

    expect(result.characters).toHaveLength(2);
    expect(result.spent).toBe(3);
  });

  /** Состав из четвёрок бесплатен — на этом формат с бюджетом и стоит. */
  it('четырёхзвёздочные ничего не стоят', () => {
    expect(buildRoster(submission({ characterIds: [FISCHL] })).spent).toBe(0);
  });

  it('повторы схлопываются: заявить одного дважды нельзя', () => {
    const result = buildRoster(submission({ characterIds: [HUTAO, HUTAO, FISCHL] }));

    expect(result.characters).toHaveLength(2);
  });

  it('пустая заявка отвергается', () => {
    expect(() => buildRoster(submission({ characterIds: [] }))).toThrow(UserError);
  });

  /** Восемь — это две половины этажа по четыре. Девятый на нём не сыграет никак. */
  it('больше восьми заявить нельзя', () => {
    const many = Array.from({ length: 9 }, (_, index) => `id-${index}`);
    const roster = many.map((id) => ({ id, name: id, rarity: 4, constellation: 0, sets: [] }));

    expect(() => buildRoster(submission({ characterIds: many, owned: roster }))).toThrow(/максимум 8/);
  });

  it('ровно восемь — можно', () => {
    const eight = Array.from({ length: 8 }, (_, index) => `id-${index}`);
    const roster = eight.map((id) => ({ id, name: id, rarity: 4, constellation: 0, sets: [] }));

    expect(buildRoster(submission({ characterIds: eight, owned: roster })).characters).toHaveLength(8);
  });

  /**
   * Заявка существует, чтобы соперник знал, из чего выбирали. Записать желаемое означало бы
   * лишить её смысла целиком.
   */
  it('чужого персонажа заявить нельзя', () => {
    expect(() => buildRoster(submission({ characterIds: ['10000999'] }))).toThrow(
      /нет на аккаунте/,
    );
  });
});

describe('потолок', () => {
  it('влезающая заявка проходит', () => {
    expect(buildRoster(submission({ characterIds: [HUTAO], cap: 3 })).spent).toBe(3);
  });

  it('ровно по потолку — проходит', () => {
    expect(() => buildRoster(submission({ characterIds: [HUTAO], cap: 3 }))).not.toThrow();
  });

  /** В отказе названо, на сколько именно превышено: иначе подбирать пришлось бы наугад. */
  it('превышение отвергается и называет разницу', () => {
    expect(() => buildRoster(submission({ characterIds: [HUTAO], cap: 1 }))).toThrow(/на 2/);
  });

  it('без потолка проходит что угодно', () => {
    expect(() => buildRoster(submission({ characterIds: [HUTAO, FISCHL], cap: null }))).not.toThrow();
  });

  /** Ноль — законный и очень жёсткий бюджет: проходят только четырёхзвёздочные. */
  it('нулевой потолок пропускает только бесплатных', () => {
    expect(() => buildRoster(submission({ characterIds: [FISCHL], cap: 0 }))).not.toThrow();
    expect(() => buildRoster(submission({ characterIds: [HUTAO], cap: 0 }))).toThrow(UserError);
  });
});
