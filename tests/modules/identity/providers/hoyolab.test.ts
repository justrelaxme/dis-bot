import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import {
  createHoyolabChronicle,
  describeRoster,
  explainRosterFailure,
  serverForUid,
} from '../../../../src/modules/identity/providers/hoyolab.js';

const rateLimiter: RateLimiter = {
  async acquire(): Promise<void> {},
  async close(): Promise<void> {},
};

const NOW = 1_785_000_000_000;

function chronicleWith(
  response: unknown,
  options: { cookie?: string | undefined } = { cookie: 'ltoken_v2=abc; ltuid_v2=42' },
): { chronicle: ReturnType<typeof createHoyolabChronicle>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn(async () => response);
  const client = { json } as unknown as FetchClient;
  return {
    chronicle: createHoyolabChronicle({
      client,
      rateLimiter,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      now: () => NOW,
    }),
    json,
  };
}

function okResponse(avatars: unknown[]): unknown {
  return { retcode: 0, message: 'OK', data: { avatars } };
}

describe('регион по UID', () => {
  /** В самой игре слова «os_euro» нет нигде, а запрос его требует — значит, считать. */
  it('считается по первой цифре, а десятизначная Азия — по двум', () => {
    expect(serverForUid('600000001')).toBe('os_usa');
    expect(serverForUid('700000001')).toBe('os_euro');
    expect(serverForUid('800000001')).toBe('os_asia');
    expect(serverForUid('900000001')).toBe('os_cht');
    expect(serverForUid('1800000001')).toBe('os_asia');
  });

  /** Китай живёт на другом хосте с другой солью. Делать вид, что он работает, хуже отказа. */
  it('китайские UID не поддерживаются, и это сказано прямо', () => {
    expect(serverForUid('100000001')).toBeNull();
    expect(serverForUid('200000001')).toBeNull();
    expect(serverForUid('500000001')).toBeNull();
  });
});

describe('состав аккаунта из Летописи HoYoLAB', () => {
  it('без ключа бота состав не запрашивается вовсе', async () => {
    const { chronicle, json } = chronicleWith(okResponse([]), { cookie: undefined });

    expect(chronicle.configured).toBe(false);
    await expect(chronicle.roster('700000001')).resolves.toEqual({ ok: false, reason: 'no-cookie' });
    expect(json).not.toHaveBeenCalled();
  });

  it('китайский UID не тратит запрос', async () => {
    const { chronicle, json } = chronicleWith(okResponse([]));

    await expect(chronicle.roster('100000001')).resolves.toEqual({ ok: false, reason: 'unsupported-region' });
    expect(json).not.toHaveBeenCalled();
  });

  it('отдаёт персонажей с уровнем и созвездием', async () => {
    const { chronicle } = chronicleWith(
      okResponse([
        { id: 10000002, name: 'Аяка', rarity: 5, level: 90, actived_constellation_num: 2 },
        { id: 10000031, name: 'Фишль', rarity: 4, level: 80, actived_constellation_num: 6 },
      ]),
    );

    const result = await chronicle.roster('700000001');

    expect(result).toEqual({
      ok: true,
      characters: [
        { id: '10000002', name: 'Аяка', level: 90, constellation: 2, rarity: 5, sets: [] },
        { id: '10000031', name: 'Фишль', level: 80, constellation: 6, rarity: 4, sets: [] },
      ],
    });
  });

  /**
   * Идентификатор строкой, и это не косметика: в пуле драфта персонаж лежит под ключом из
   * справочника Enka, тоже строкой. Число здесь не сошлось бы с ним ни разу.
   */
  it('идентификатор — строка, как в справочнике персонажей', async () => {
    const { chronicle } = chronicleWith(okResponse([{ id: 10000002, name: 'Аяка' }]));

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters[0]?.id).toBe('10000002');
  });

  /** Пробным персонажам HoYoLAB ставит редкость 105 вместо 5. Иначе «пятизвёздочных: 0». */
  it('редкость сверх сотни приводится к обычной', async () => {
    const { chronicle } = chronicleWith(okResponse([{ id: 10000002, name: 'Аяка', rarity: 105 }]));

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters[0]?.rarity).toBe(5);
  });

  it('пятизвёздочные идут первыми, дальше по уровню', async () => {
    const { chronicle } = chronicleWith(
      okResponse([
        { id: 1, name: 'Четыре низкий', rarity: 4, level: 20 },
        { id: 2, name: 'Пять низкий', rarity: 5, level: 40 },
        { id: 3, name: 'Четыре высокий', rarity: 4, level: 90 },
        { id: 4, name: 'Пять высокий', rarity: 5, level: 90 },
      ]),
    );

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters.map((character) => character.name)).toEqual([
      'Пять высокий',
      'Пять низкий',
      'Четыре высокий',
      'Четыре низкий',
    ]);
  });

  it('закрытая Летопись — своя причина, а не общее «не получилось»', async () => {
    for (const retcode of [10102, 10104, 1034]) {
      const { chronicle } = chronicleWith({ retcode, message: 'private' });
      await expect(chronicle.roster('700000001')).resolves.toEqual({ ok: false, reason: 'private' });
    }
  });

  it('прочий отказ HoYoLAB — недоступность', async () => {
    const { chronicle } = chronicleWith({ retcode: 10001, message: 'Please login' });

    await expect(chronicle.roster('700000001')).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  /** Турнир не должен зависеть от настроения чужого API: сеть падает — состав неизвестен. */
  it('сетевой сбой не бросается наверх', async () => {
    const json = vi.fn(async () => {
      throw new Error('соединение оборвалось');
    });
    const chronicle = createHoyolabChronicle({
      client: { json } as unknown as FetchClient,
      rateLimiter,
      cookie: 'ltoken_v2=abc',
      now: () => NOW,
    });

    await expect(chronicle.roster('700000001')).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('запрос уходит POST-ом с UID, регионом и cookie', async () => {
    const { chronicle, json } = chronicleWith(okResponse([]));

    await chronicle.roster('700000001');

    const [url, init] = json.mock.calls[0] as [string, { method?: string; body?: string; headers?: Record<string, string> }];
    expect(url).toContain('/game_record/genshin/api/character');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ role_id: '700000001', server: 'os_euro' });
    expect(init.headers?.['Cookie']).toContain('ltoken_v2');
  });

  /**
   * Подпись — единственное, что отличает наш запрос от отброшенного. Формат `t,r,md5` с
   * солью, и проверяется он воспроизведением: иначе сломанная подпись выглядела бы как
   * закрытая Летопись у всех игроков сразу.
   */
  it('подписывает запрос: время, случайные буквы и md5 от них с солью', async () => {
    const { chronicle, json } = chronicleWith(okResponse([]));

    await chronicle.roster('700000001');

    const init = json.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    const ds = init.headers?.['DS'] ?? '';
    const [time, random, hash] = ds.split(',');

    expect(time).toBe(String(Math.floor(NOW / 1_000)));
    expect(random).toMatch(/^[a-zA-Z0-9]{6}$/);
    const expected = createHash('md5')
      .update(`salt=6s25p5ox5y14umn1p61aqyyvbvvl3lrt&t=${time}&r=${random}`)
      .digest('hex');
    expect(hash).toBe(expected);
    expect(init.headers?.['x-rpc-client_type']).toBe('5');
  });
});

describe('что сказать игроку', () => {
  /** Каждая причина — своё действие. «Попробуй позже» при закрытой Летописи не поможет никогда. */
  it('у каждой причины своя подсказка, и все они разные', () => {
    const texts = (['no-cookie', 'unsupported-region', 'private', 'unavailable'] as const).map(
      explainRosterFailure,
    );

    expect(new Set(texts).size).toBe(texts.length);
    expect(explainRosterFailure('private')).toContain('HoYoLAB');
  });

  it('одна строка про состав считает пятизвёздочных', () => {
    const text = describeRoster([
      { id: '1', name: 'а', level: 90, constellation: 0, rarity: 5, sets: [] },
      { id: '2', name: 'б', level: 90, constellation: 0, rarity: 5, sets: [] },
      { id: '3', name: 'в', level: 80, constellation: 0, rarity: 4, sets: [] },
    ]);

    expect(text).toBe('персонажей 3, из них пятизвёздочных 2');
  });
});

/**
 * Оружие и артефакты. Ради них Летопись и читается вторым заходом: созвездие говорит, кто у
 * игрока есть, а оружие с огранкой — сколько в него вложено, и именно это считает бюджет
 * турнира.
 */
describe('оружие и артефакты в составе', () => {
  it('оружие приходит с редкостью и огранкой', async () => {
    const { chronicle } = chronicleWith(
      okResponse([
        {
          id: 10000046,
          name: 'Ху Тао',
          rarity: 5,
          level: 90,
          actived_constellation_num: 1,
          weapon: { name: 'Нефритовый секач', rarity: 5, level: 90, affix_level: 1 },
        },
      ]),
    );

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters[0]?.weapon).toEqual({
      name: 'Нефритовый секач',
      rarity: 5,
      refinement: 1,
      level: 90,
    });
  });

  /** У неподнятого персонажа оружия может не быть вовсе — это «неизвестно», а не сбой. */
  it('без оружия персонаж всё равно читается', async () => {
    const { chronicle } = chronicleWith(okResponse([{ id: 10000046, name: 'Ху Тао', rarity: 5 }]));

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters[0]?.weapon).toBeUndefined();
    expect(result.ok && result.characters[0]?.sets).toEqual([]);
  });

  it('артефакты сводятся в комплекты: «четыре из такого-то»', async () => {
    const { chronicle } = chronicleWith(
      okResponse([
        {
          id: 10000046,
          name: 'Ху Тао',
          rarity: 5,
          reliquaries: [
            { set: { name: 'Багровая ведьма пламени' } },
            { set: { name: 'Багровая ведьма пламени' } },
            { set: { name: 'Багровая ведьма пламени' } },
            { set: { name: 'Багровая ведьма пламени' } },
            { set: { name: 'Тень Шимэнава' } },
          ],
        },
      ]),
    );

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters[0]?.sets).toEqual([
      { name: 'Багровая ведьма пламени', pieces: 4 },
      { name: 'Тень Шимэнава', pieces: 1 },
    ]);
  });

  /** Больший комплект вперёд: он определяет сборку целиком, а второй лишь дополняет. */
  it('комплекты идут от большего к меньшему', async () => {
    const { chronicle } = chronicleWith(
      okResponse([
        {
          id: 10000046,
          name: 'Ху Тао',
          rarity: 5,
          reliquaries: [
            { set: { name: 'Второй' } },
            { set: { name: 'Второй' } },
            { set: { name: 'Первый' } },
            { set: { name: 'Первый' } },
            { set: { name: 'Первый' } },
          ],
        },
      ]),
    );

    const result = await chronicle.roster('700000001');

    expect(result.ok && result.characters[0]?.sets.map((set) => set.pieces)).toEqual([3, 2]);
  });
});
