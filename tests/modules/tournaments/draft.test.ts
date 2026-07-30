import { describe, expect, it } from 'vitest';
import {
  autoChoice,
  canChoose,
  draftProgress,
  draftView,
  type DraftChoice,
} from '../../../src/modules/tournaments/draft/engine.js';
import {
  DOTA_DRAFT_SEQUENCE,
  VALORANT_MAPS,
  draftSubject,
  mapVetoSequence,
  type DraftOption,
  type DraftStep,
} from '../../../src/modules/tournaments/draft/pools.js';

const pool: DraftOption[] = [
  { id: 'a', label: 'Ascent' },
  { id: 'b', label: 'Bind' },
  { id: 'c', label: 'Haven' },
  { id: 'd', label: 'Icebox' },
];

function choose(
  sequence: readonly DraftStep[],
  ids: (string | null)[],
): DraftChoice[] {
  return ids.map((optionId, index) => {
    const step = sequence[index];
    if (!step) throw new Error(`шага ${index} нет в последовательности`);
    return { step: index, side: step.side, kind: step.kind, optionId };
  });
}

describe('последовательность вето карт', () => {
  it('на одну карту банят по очереди до последней оставшейся', () => {
    const sequence = mapVetoSequence(7, 1);

    expect(sequence).toHaveLength(6);
    expect(sequence.every((step) => step.kind === 'ban')).toBe(true);
    expect(sequence.map((step) => step.side)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('на три карты банят, выбирают, потом добивают банами', () => {
    const sequence = mapVetoSequence(7, 3);

    expect(sequence.slice(0, 4)).toEqual([
      { side: 'a', kind: 'ban' },
      { side: 'b', kind: 'ban' },
      { side: 'a', kind: 'pick' },
      { side: 'b', kind: 'pick' },
    ]);
    // После двух банов и двух пиков осталось три — добиваем до одной решающей.
    expect(sequence).toHaveLength(6);
    expect(sequence.slice(4).every((step) => step.kind === 'ban')).toBe(true);
  });

  it('на пуле меньше двух карт делить нечего', () => {
    expect(mapVetoSequence(1, 1)).toEqual([]);
    expect(mapVetoSequence(0, 3)).toEqual([]);
  });

  it('право первого бана уравновешено правом первого пика', () => {
    const sequence = mapVetoSequence(7, 3);
    const firstBan = sequence.find((step) => step.kind === 'ban');
    const firstPick = sequence.find((step) => step.kind === 'pick');

    expect(firstBan?.side).toBe('a');
    expect(firstPick?.side).toBe('a');
  });
});

describe('последовательность драфта героев', () => {
  it('по два бана каждому и по пять пиков', () => {
    const bans = DOTA_DRAFT_SEQUENCE.filter((step) => step.kind === 'ban');
    const picks = DOTA_DRAFT_SEQUENCE.filter((step) => step.kind === 'pick');

    expect(bans).toHaveLength(4);
    expect(bans.filter((step) => step.side === 'a')).toHaveLength(2);
    expect(picks).toHaveLength(10);
    expect(picks.filter((step) => step.side === 'a')).toHaveLength(5);
    expect(picks.filter((step) => step.side === 'b')).toHaveLength(5);
  });

  /**
   * Змейка нужна, чтобы право первого пика не превращалось в преимущество: у кого первый
   * пик, у того второй и третий — последние. Проверяем именно это, а не буквальный порядок:
   * порядок можно поменять, свойство — нет.
   */
  it('пики идут змейкой: никто не выбирает трижды подряд', () => {
    const picks = DOTA_DRAFT_SEQUENCE.filter((step) => step.kind === 'pick').map((step) => step.side);

    for (let index = 0; index + 2 < picks.length; index += 1) {
      const three = picks.slice(index, index + 3);
      expect(new Set(three).size, `подряд три пика у одной стороны на позиции ${index}`).toBeGreaterThan(1);
    }
  });

  it('баны идут до пиков', () => {
    const lastBan = DOTA_DRAFT_SEQUENCE.findLastIndex((step) => step.kind === 'ban');
    const firstPick = DOTA_DRAFT_SEQUENCE.findIndex((step) => step.kind === 'pick');

    expect(lastBan).toBeLessThan(firstPick);
  });
});

describe('какие дисциплины драфтятся', () => {
  it('Dota — герои, Valorant — карты, остальным не нужно', () => {
    expect(draftSubject('dota2')).toBe('heroes');
    expect(draftSubject('valorant')).toBe('maps');
    expect(draftSubject('lol')).toBeNull();
    expect(draftSubject('tft')).toBeNull();
  });
});

describe('состояние драфта', () => {
  const sequence = mapVetoSequence(4, 1);

  it('в начале ход первой стороны и доступно всё', () => {
    const view = draftView(pool, sequence, []);

    expect(view.step).toBe(0);
    expect(view.current).toEqual({ side: 'a', kind: 'ban' });
    expect(view.done).toBe(false);
    expect(view.available).toHaveLength(4);
    expect(view.result).toEqual([]);
  });

  it('забаненное уходит из доступного', () => {
    const view = draftView(pool, sequence, choose(sequence, ['a']));

    expect(view.banned).toEqual(['a']);
    expect(view.available.map((option) => option.id)).toEqual(['b', 'c', 'd']);
    expect(view.current).toEqual({ side: 'b', kind: 'ban' });
  });

  it('пропущенный бан продвигает ход, но ничего не занимает', () => {
    const view = draftView(pool, sequence, choose(sequence, [null]));

    expect(view.step).toBe(1);
    expect(view.banned).toEqual([]);
    expect(view.available).toHaveLength(4);
  });

  it('после последнего шага драфт закончен, а итог — единственная оставшаяся карта', () => {
    const view = draftView(pool, sequence, choose(sequence, ['a', 'b', 'c']));

    expect(view.done).toBe(true);
    expect(view.current).toBeNull();
    expect(view.result.map((option) => option.id)).toEqual(['d']);
  });

  it('при трёх картах итог — выбранные плюс решающая', () => {
    const bo3 = mapVetoSequence(4, 3);
    // Банят по одной, выбирают по одной — решающей не остаётся, пул слишком мал.
    const view = draftView(pool, bo3, choose(bo3, ['a', 'b', 'c', 'd']));

    expect(view.done).toBe(true);
    expect(view.pickedA).toEqual(['c']);
    expect(view.pickedB).toEqual(['d']);
    expect(view.result.map((option) => option.id).sort()).toEqual(['c', 'd']);
  });

  it('прогресс не выходит за длину последовательности', () => {
    expect(draftProgress(sequence, choose(sequence, ['a']))).toEqual({ total: 3, done: 1 });
    expect(draftProgress(sequence, choose(sequence, ['a', 'b', 'c']))).toEqual({ total: 3, done: 3 });
  });
});

describe('право на ход', () => {
  const sequence = mapVetoSequence(4, 1);

  it('ходить может только та сторона, чей ход', () => {
    const view = draftView(pool, sequence, []);

    expect(canChoose(view, 'a', 'a')).toEqual({ ok: true });
    expect(canChoose(view, 'b', 'a')).toEqual({ ok: false, reason: 'Сейчас ход соперника.' });
  });

  it('занятое выбрать нельзя', () => {
    const view = draftView(pool, sequence, choose(sequence, ['a']));

    expect(canChoose(view, 'b', 'a')).toEqual({ ok: false, reason: 'Этот вариант уже занят.' });
    expect(canChoose(view, 'b', 'b')).toEqual({ ok: true });
  });

  it('бан можно пропустить, а пик нельзя', () => {
    const bo3 = mapVetoSequence(4, 3);

    expect(canChoose(draftView(pool, bo3, []), 'a', null)).toEqual({ ok: true });
    const atPick = draftView(pool, bo3, choose(bo3, ['a', 'b']));
    expect(atPick.current?.kind).toBe('pick');
    expect(canChoose(atPick, 'a', null)).toEqual({
      ok: false,
      reason: 'Пик пропустить нельзя — выбери вариант.',
    });
  });

  it('в законченном драфте ходить нельзя никому', () => {
    const view = draftView(pool, sequence, choose(sequence, ['a', 'b', 'c']));

    expect(canChoose(view, 'a', 'd')).toEqual({ ok: false, reason: 'Драфт уже закончен.' });
  });
});

describe('ход за того, кто не успел', () => {
  const sequence = mapVetoSequence(4, 3);

  it('бан пропускается: навязывать бан значило бы решать за игрока', () => {
    expect(autoChoice(draftView(pool, sequence, []))).toBeNull();
  });

  it('пик берётся первым свободным: без него драфт не закончится никогда', () => {
    const atPick = draftView(pool, sequence, choose(sequence, ['a', 'b']));

    expect(atPick.current?.kind).toBe('pick');
    // Первый свободный, а не случайный: случайность в необратимом действии нельзя ни
    // проверить, ни объяснить пострадавшему.
    expect(autoChoice(atPick)).toBe('c');
  });

  it('в законченном драфте выбирать нечего', () => {
    const done = draftView(pool, sequence, choose(sequence, ['a', 'b', 'c', 'd']));
    expect(autoChoice(done)).toBeNull();
  });
});

/**
 * Сквозной прогон вето на настоящем пуле карт: пул может измениться, а свойство «в конце
 * остаётся ровно одна карта» — нет. Если Riot добавит карту и пул станет чётным, тест
 * поймает это раньше живого матча.
 */
describe('прогон вето на настоящем пуле', () => {
  it('после всех банов остаётся ровно одна карта', () => {
    const maps = [...VALORANT_MAPS];
    const sequence = mapVetoSequence(maps.length, 1);

    const made: DraftChoice[] = [];
    for (let step = 0; step < sequence.length; step += 1) {
      const view = draftView(maps, sequence, made);
      expect(view.done).toBe(false);
      const pick = view.available[0];
      expect(pick).toBeDefined();
      made.push({
        step,
        side: view.current?.side as 'a' | 'b',
        kind: view.current?.kind as 'ban' | 'pick',
        optionId: pick?.id ?? null,
      });
    }

    const final = draftView(maps, sequence, made);
    expect(final.done).toBe(true);
    expect(final.result).toHaveLength(1);
    expect(final.banned).toHaveLength(maps.length - 1);
  });
});
