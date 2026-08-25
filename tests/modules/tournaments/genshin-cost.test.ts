import { describe, expect, it } from 'vitest';
import {
  budgetVerdict,
  characterCost,
  costOf,
  formatCost,
  teamCost,
  weaponCost,
  type CostedCharacter,
} from '../../../src/modules/tournaments/genshin/cost.js';

/**
 * Система очков сообщества. Числа здесь не наши, поэтому и проверяются они как чужие: по
 * примерам из исходной таблицы, а не по тому, как их запомнил код.
 *
 *   Лимитированный 5★: C0 = 1, C2 = 3, C6 = 7
 *   Стандартный 5★:    C0 = 0.5, C2 = 1.5, C6 = 3.5
 *   4★:                0 при любом созвездии
 *   Лимитированное оружие: R1 = 1, R5 = 5
 *   Стандартное оружие:    R1 = 0.5, R5 = 2.5
 */

/** Ху Тао — лимитированная пятизвёздочная. */
const HUTAO = '10000046';
/** Джинн — стандартная пятизвёздочная, из постоянной молитвы. */
const JEAN = '10000003';
/** Фишль — четырёхзвёздочная. */
const FISCHL = '10000031';

const character = (over: Partial<CostedCharacter> = {}): CostedCharacter => ({
  id: HUTAO,
  name: 'Ху Тао',
  rarity: 5,
  constellation: 0,
  ...over,
});

describe('стоимость персонажа', () => {
  it('лимитированный пятизвёздочный: созвездие плюс один', () => {
    expect(characterCost({ id: HUTAO, rarity: 5, constellation: 0 })).toBe(1);
    expect(characterCost({ id: HUTAO, rarity: 5, constellation: 2 })).toBe(3);
    expect(characterCost({ id: HUTAO, rarity: 5, constellation: 6 })).toBe(7);
  });

  it('стандартный пятизвёздочный — вдвое дешевле', () => {
    expect(characterCost({ id: JEAN, rarity: 5, constellation: 0 })).toBe(0.5);
    expect(characterCost({ id: JEAN, rarity: 5, constellation: 2 })).toBe(1.5);
    expect(characterCost({ id: JEAN, rarity: 5, constellation: 6 })).toBe(3.5);
  });

  /**
   * Не «дешевле», а ноль — и это то, что делает формат с бюджетом интересным: состав из
   * четвёрок не стоит ничего, и вопрос в том, соберёшь ли ты им этаж.
   */
  it('четырёхзвёздочный бесплатен при любом созвездии', () => {
    for (const constellation of [0, 3, 6]) {
      expect(characterCost({ id: FISCHL, rarity: 4, constellation })).toBe(0);
    }
  });

  it('Путешественник бесплатен: он есть у каждого по определению', () => {
    expect(characterCost({ id: '10000005', rarity: 5, constellation: 6 })).toBe(0);
    expect(characterCost({ id: '10000007-703', rarity: 5, constellation: 6 })).toBe(0);
  });

  /**
   * Незнакомый пятизвёздочный считается лимитированным. Ошибка в эту сторону безопасна:
   * состав выглядит дороже, чем он есть, и это видно организатору — а не наоборот, когда
   * дорогой аккаунт незаметно проходит по бюджету.
   */
  it('незнакомый пятизвёздочный считается лимитированным, а не стандартным', () => {
    expect(characterCost({ id: '10000999', rarity: 5, constellation: 0 })).toBe(1);
  });

  it('созвездие вне диапазона не ломает счёт', () => {
    expect(characterCost({ id: HUTAO, rarity: 5, constellation: 9 })).toBe(7);
    expect(characterCost({ id: HUTAO, rarity: 5, constellation: -3 })).toBe(1);
    expect(characterCost({ id: HUTAO, rarity: 5, constellation: Number.NaN })).toBe(1);
  });
});

describe('стоимость оружия', () => {
  it('лимитированное пятизвёздочное: огранка как есть', () => {
    expect(weaponCost({ name: 'Нефритовый секач', rarity: 5, refinement: 1 })).toBe(1);
    expect(weaponCost({ name: 'Нефритовый секач', rarity: 5, refinement: 5 })).toBe(5);
  });

  it('стандартное пятизвёздочное — вдвое дешевле', () => {
    expect(weaponCost({ name: 'Меч Фавония', rarity: 5, refinement: 1 })).toBe(0.5);
    expect(weaponCost({ name: 'Могильщик волков', rarity: 5, refinement: 5 })).toBe(2.5);
  });

  it('стандартное узнаётся и по-английски, и в любом регистре', () => {
    expect(weaponCost({ name: 'Skyward Harp', rarity: 5, refinement: 2 })).toBe(1);
    expect(weaponCost({ name: '  МОГИЛЬЩИК ВОЛКОВ ', rarity: 5, refinement: 2 })).toBe(1);
  });

  it('четырёхзвёздочное и ниже бесплатно при любой огранке', () => {
    expect(weaponCost({ name: 'Череп странника', rarity: 4, refinement: 5 })).toBe(0);
    expect(weaponCost({ name: 'Дубина белой кисти', rarity: 3, refinement: 5 })).toBe(0);
  });

  /** Летопись может не отдать оружие вовсе — это не повод считать состав бесплатным или падать. */
  it('неизвестное оружие стоит ноль', () => {
    expect(weaponCost(undefined)).toBe(0);
  });

  it('огранка вне диапазона не ломает счёт', () => {
    expect(weaponCost({ name: 'Нефритовый секач', rarity: 5, refinement: 0 })).toBe(1);
    expect(weaponCost({ name: 'Нефритовый секач', rarity: 5, refinement: 99 })).toBe(5);
  });
});

describe('стоимость персонажа с оружием', () => {
  it('складывает персонажа и оружие', () => {
    const cost = costOf(
      character({ constellation: 2, weapon: { name: 'Нефритовый секач', rarity: 5, refinement: 1 } }),
    );

    expect(cost).toEqual({ character: 3, weapon: 1, total: 4 });
  });

  /** Половинки складываются в двоичные хвосты — в отчёте их быть не должно. */
  it('половинные очки не превращаются в хвост из девяток', () => {
    const cost = costOf({
      id: JEAN,
      name: 'Джинн',
      rarity: 5,
      constellation: 0,
      weapon: { name: 'Меч Фавония', rarity: 5, refinement: 1 },
    });

    expect(cost.total).toBe(1);
  });
});

describe('стоимость состава', () => {
  it('суммирует и показывает, кто сколько съел', () => {
    const team = teamCost([
      character({ constellation: 0 }),
      character({ id: FISCHL, name: 'Фишль', rarity: 4, constellation: 6 }),
      character({ id: JEAN, name: 'Джинн', constellation: 1 }),
    ]);

    expect(team.total).toBe(2);
    expect(team.perCharacter.map((entry) => entry.cost.total)).toEqual([1, 0, 1]);
  });

  /** Состав целиком из четвёрок — законный и бесплатный: на этом формат с бюджетом и стоит. */
  it('состав из четырёхзвёздочных стоит ноль', () => {
    const team = teamCost([
      character({ id: FISCHL, name: 'Фишль', rarity: 4, constellation: 6 }),
      character({ id: '10000032', name: 'Беннет', rarity: 4, constellation: 6 }),
    ]);

    expect(team.total).toBe(0);
  });

  it('пустой состав стоит ноль, а не ломается', () => {
    expect(teamCost([]).total).toBe(0);
  });
});

describe('бюджет', () => {
  it('влезает — превышения нет', () => {
    expect(budgetVerdict(5, 6)).toEqual({ fits: true, over: 0, cap: 6, spent: 5 });
  });

  it('ровно по потолку — влезает', () => {
    expect(budgetVerdict(6, 6).fits).toBe(true);
  });

  it('превышение считается и называется', () => {
    expect(budgetVerdict(8.5, 6)).toEqual({ fits: false, over: 2.5, cap: 6, spent: 8.5 });
  });

  /** Без потолка играют чем есть — это обычный турнир, а не особый случай. */
  it('без потолка влезает что угодно', () => {
    expect(budgetVerdict(42, null)).toEqual({ fits: true, over: 0, cap: null, spent: 42 });
  });
});

describe('очки словами', () => {
  it('целые без хвоста, половинки как есть', () => {
    expect(formatCost(3)).toBe('3');
    expect(formatCost(3.5)).toBe('3.5');
    expect(formatCost(0)).toBe('0');
  });
});
