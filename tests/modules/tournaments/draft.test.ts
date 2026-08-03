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
  GENSHIN_ROSTER,
  bansFor,
  draftSubject,
  mapVetoSequence,
  pickBanSequence,
  picksBlockOpponent,
  picksFor,
  poolFits,
  survivorsAreResult,
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
      { side: 'a', kind: 'ban', group: 'maps' },
      { side: 'b', kind: 'ban', group: 'maps' },
      { side: 'a', kind: 'pick', group: 'maps' },
      { side: 'b', kind: 'pick', group: 'maps' },
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
  it('Dota — герои, Valorant — карты, Genshin — персонажи, остальным не нужно', () => {
    expect(draftSubject('dota2')).toBe('heroes');
    expect(draftSubject('valorant')).toBe('maps');
    expect(draftSubject('genshin')).toBe('characters');
    expect(draftSubject('lol')).toBeNull();
    expect(draftSubject('tft')).toBeNull();
  });
});

describe('состояние драфта', () => {
  const sequence = mapVetoSequence(4, 1);

  it('в начале ход первой стороны и доступно всё', () => {
    const view = draftView(pool, sequence, []);

    expect(view.step).toBe(0);
    expect(view.current).toEqual({ side: 'a', kind: 'ban', group: 'maps' });
    expect(view.done).toBe(false);
    expect(view.available).toHaveLength(4);
    expect(view.result).toEqual([]);
  });

  it('забаненное уходит из доступного', () => {
    const view = draftView(pool, sequence, choose(sequence, ['a']));

    expect(view.banned).toEqual(['a']);
    expect(view.available.map((option) => option.id)).toEqual(['b', 'c', 'd']);
    expect(view.current).toEqual({ side: 'b', kind: 'ban', group: 'maps' });
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

describe('последовательность банов и пиков под формат', () => {
  /**
   * Змейка обязана уравнивать стороны при любом числе пиков, а не только при пяти. Проверяем
   * свойство на всём разумном диапазоне: размер команды — настройка, и однажды кто-то
   * поставит три.
   */
  it('стороны получают равно пиков при любом размере команды', () => {
    for (let perSide = 1; perSide <= 8; perSide += 1) {
      const picks = pickBanSequence('heroes', perSide, 2).filter((step) => step.kind === 'pick');

      expect(picks.filter((step) => step.side === 'a'), `пиков A при ${perSide}`).toHaveLength(perSide);
      expect(picks.filter((step) => step.side === 'b'), `пиков B при ${perSide}`).toHaveLength(perSide);
    }
  });

  it('никто не выбирает трижды подряд при любом размере команды', () => {
    for (let perSide = 2; perSide <= 8; perSide += 1) {
      const sides = pickBanSequence('agents', perSide, 1)
        .filter((step) => step.kind === 'pick')
        .map((step) => step.side);

      for (let index = 0; index + 2 < sides.length; index += 1) {
        expect(new Set(sides.slice(index, index + 3)).size, `три подряд при ${perSide}`).toBeGreaterThan(1);
      }
    }
  });

  /**
   * Драфт на пятерых в матче один на один выдавал бы игроку четырёх лишних героев. Размер
   * команды — то, откуда берётся число пиков, и это ровно та ошибка, которую тест держит.
   */
  it('в одиночном матче по одному пику и по одному бану', () => {
    expect(pickBanSequence('agents', 1, bansFor(1))).toEqual([
      { side: 'a', kind: 'ban', group: 'agents' },
      { side: 'b', kind: 'ban', group: 'agents' },
      { side: 'a', kind: 'pick', group: 'agents' },
      { side: 'b', kind: 'pick', group: 'agents' },
    ]);
  });

  it('банов два в командном матче и один в одиночном', () => {
    expect(bansFor(5)).toBe(2);
    expect(bansFor(1)).toBe(1);
  });

  /**
   * Число пиков задаёт то, что делят, а не размер состава. У персонажей Genshin это этаж
   * Бездны: четыре на половину, а половин две. Считать их по размеру состава значило бы
   * выдать участнику турнира один на один одного персонажа — и отправить его во вторую
   * половину этажа вообще без команды.
   */
  it('персонажей Genshin берут восемь на сторону, сколько бы ни было участников', () => {
    expect(picksFor('characters', 1)).toBe(GENSHIN_ROSTER);
    expect(picksFor('characters', 5)).toBe(GENSHIN_ROSTER);
    expect(GENSHIN_ROSTER).toBe(8);
  });

  it('у героев и агентов пиков столько же, сколько людей в команде', () => {
    expect(picksFor('heroes', 5)).toBe(5);
    expect(picksFor('agents', 1)).toBe(1);
  });

  /** Два бана из ста одиннадцати почти не меняли бы расклад, ради которого баны и заводились. */
  it('у персонажей банов три: пул большой, а решают его единицы', () => {
    expect(bansFor(GENSHIN_ROSTER, 'characters')).toBe(3);
    expect(bansFor(1, 'characters')).toBe(3);
  });

  it('драфт персонажей укладывается в пул: шесть банов и по восемь пиков на сторону', () => {
    const steps = pickBanSequence('characters', GENSHIN_ROSTER, bansFor(GENSHIN_ROSTER, 'characters'));

    expect(steps).toHaveLength(6 + GENSHIN_ROSTER * 2);
    expect(poolFits(111, steps, 'characters')).toBe(true);
    // Худшая сторона: шесть общих банов плюс её восемь пиков. Тринадцати уже не хватает.
    expect(poolFits(14, steps, 'characters')).toBe(true);
    expect(poolFits(13, steps, 'characters')).toBe(false);
  });

  /** Персонаж, взятый соперником, у своего аккаунта не исчезает — пул зеркальный. */
  it('пик персонажа не забирает его у соперника', () => {
    expect(picksBlockOpponent('characters')).toBe(false);
    expect(survivorsAreResult('characters')).toBe(false);
  });

  it('пул меньше нужного не подходит: банить было бы что, а выбирать нечего', () => {
    const steps = pickBanSequence('agents', 5, 2);

    // Порог считается по худшей стороне: четыре общих бана плюс пять её собственных пиков.
    expect(poolFits(29, steps, 'agents')).toBe(true);
    expect(poolFits(6, steps, 'agents')).toBe(false);
  });

  it('пятёрка Dota осталась тем же порядком, что и была', () => {
    expect(DOTA_DRAFT_SEQUENCE).toEqual(pickBanSequence('heroes', 5, 2));
  });
});

describe('итог фазы', () => {
  it('у карт уцелевшая считается итогом, у героев и агентов — нет', () => {
    expect(survivorsAreResult('maps')).toBe(true);
    expect(survivorsAreResult('heroes')).toBe(false);
    expect(survivorsAreResult('agents')).toBe(false);
  });

  /**
   * Забанили одного из шести, взяли двоих — «итогом» остальные три не являются ни в каком
   * смысле. Пока итог считался как «выбранное плюс уцелевшее» для всех наборов, законченный
   * драфт Dota показывал сто тринадцать посторонних героев.
   */
  it('у героев итог — только выбранное, без всех незабаненных', () => {
    const heroes: DraftOption[] = ['axe', 'lina', 'pudge', 'sniper', 'lion', 'tiny'].map((id) => ({
      id,
      label: id,
      group: 'heroes',
    }));
    const sequence = pickBanSequence('heroes', 1, 1);

    const view = draftView(heroes, sequence, choose(sequence, ['axe', 'lina', 'pudge', 'sniper']), 'heroes');

    expect(view.done).toBe(true);
    expect(view.result.map((option) => option.id)).toEqual(['pudge', 'sniper']);
  });
});

/**
 * Зеркальные пулы. Ради этого драфт героев и агентов вообще нужен: чужой пик виден, и под
 * него берут контрпик. Пул, который блокирует героя за соперником, эту ценность уничтожает —
 * контрить нечем, если контрпик уже забрали. Карты — исключение: играют на одной.
 */
describe('пик соперника не забирает героя', () => {
  const heroes: DraftOption[] = ['axe', 'lina', 'pudge', 'sniper', 'lion', 'tiny'].map((id) => ({
    id,
    label: id,
    group: 'heroes',
  }));
  const sequence = pickBanSequence('heroes', 2, 1);

  it('у карт пик забирает, у героев и агентов — нет', () => {
    expect(picksBlockOpponent('maps')).toBe(true);
    expect(picksBlockOpponent('heroes')).toBe(false);
    expect(picksBlockOpponent('agents')).toBe(false);
  });

  it('взятого соперником героя можно взять себе', () => {
    // Баны A и B, потом пик A берёт pudge. Дальше ход B — pudge обязан быть доступен.
    const view = draftView(heroes, sequence, choose(sequence, ['axe', 'lina', 'pudge']), 'heroes');

    expect(view.current).toEqual({ side: 'b', kind: 'pick', group: 'heroes' });
    expect(view.available.map((option) => option.id)).toContain('pudge');
    expect(canChoose(view, 'b', 'pudge')).toEqual({ ok: true });
  });

  it('своего же взятого героя второй раз взять нельзя', () => {
    // Порядок при двух пиках на сторону: бан A, бан B, пик A, пик B, пик B, пик A.
    // A взял pudge своим первым пиком; на шестом шаге ход снова его — у себя pudge занят.
    const view = draftView(
      heroes,
      sequence,
      choose(sequence, ['axe', 'lina', 'pudge', 'pudge', 'sniper']),
      'heroes',
    );

    expect(view.current?.side).toBe('a');
    expect(canChoose(view, 'a', 'pudge')).toEqual({ ok: false, reason: 'Этот вариант уже занят.' });
    expect(view.available.map((option) => option.id)).not.toContain('pudge');
    // А взятого соперником sniper — можно: пул зеркальный.
    expect(canChoose(view, 'a', 'sniper')).toEqual({ ok: true });
  });

  it('забаненного не берёт никто', () => {
    const view = draftView(heroes, sequence, choose(sequence, ['axe', 'lina']), 'heroes');

    expect(view.current?.kind).toBe('pick');
    expect(view.available.map((option) => option.id)).toEqual(['pudge', 'sniper', 'lion', 'tiny']);
    expect(canChoose(view, 'a', 'axe')).toEqual({ ok: false, reason: 'Этот вариант уже занят.' });
  });

  it('обе стороны могут собрать одинаковый состав', () => {
    const full = draftView(
      heroes,
      sequence,
      choose(sequence, ['axe', 'lina', 'pudge', 'pudge', 'sniper', 'sniper']),
      'heroes',
    );

    expect(full.done).toBe(true);
    expect(full.pickedA).toEqual(['pudge', 'sniper']);
    expect(full.pickedB).toEqual(['pudge', 'sniper']);
    // В итоге герой один раз: показывать «Pudge, Pudge» было бы бессмысленно.
    expect(full.result.map((option) => option.id)).toEqual(['pudge', 'sniper']);
  });

  it('автоход тоже видит взятое соперником как свободное', () => {
    const view = draftView(heroes, sequence, choose(sequence, ['axe', 'lina', 'pudge']), 'heroes');

    // Первый свободный для стороны B — именно pudge, взятый стороной A.
    expect(autoChoice(view)).toBe('pudge');
  });

  /**
   * Карты остаются общими: взятую соперником карту забрать нельзя, потому что играть на ней
   * будут оба.
   */
  it('карту, взятую соперником, забрать нельзя', () => {
    const maps: DraftOption[] = ['ascent', 'bind', 'haven', 'icebox'].map((id) => ({
      id,
      label: id,
      group: 'maps',
    }));
    const bo3 = mapVetoSequence(maps.length, 3);
    const view = draftView(maps, bo3, choose(bo3, ['ascent', 'bind', 'haven']), 'maps');

    expect(view.current).toEqual({ side: 'b', kind: 'pick', group: 'maps' });
    expect(canChoose(view, 'b', 'haven')).toEqual({ ok: false, reason: 'Этот вариант уже занят.' });
  });

  it('пул считается по худшей стороне, а не по всем шагам', () => {
    const steps = pickBanSequence('agents', 5, 2);

    // Зеркальные пики: одной стороне нужны 4 бана плюс её 5 пиков — девять, а не четырнадцать.
    expect(poolFits(9, steps, 'agents')).toBe(true);
    expect(poolFits(8, steps, 'agents')).toBe(false);
  });
});

describe('две фазы: сначала карты, потом агенты', () => {
  const maps: DraftOption[] = ['ascent', 'bind', 'haven'].map((id) => ({ id, label: id, group: 'maps' }));
  const agents: DraftOption[] = ['jett', 'sage', 'omen', 'sova'].map((id) => ({
    id,
    label: id,
    group: 'agents',
  }));
  const pool = [...maps, ...agents];
  const sequence = [...mapVetoSequence(maps.length, 1), ...pickBanSequence('agents', 1, 1)];

  it('на фазе карт предлагают только карты', () => {
    const view = draftView(pool, sequence, [], 'maps');

    expect(view.group).toBe('maps');
    expect(view.available.map((option) => option.id)).toEqual(['ascent', 'bind', 'haven']);
  });

  /**
   * Карту надо знать до того, как выберут агентов: агентов выбирают под карту, и держать её
   * в секрете до самого конца драфта означало бы отобрать смысл у второй фазы.
   */
  it('решающая карта видна, пока агентов ещё выбирают', () => {
    const afterVeto = draftView(pool, sequence, choose(sequence, ['ascent', 'bind']), 'maps');

    expect(afterVeto.done).toBe(false);
    expect(afterVeto.group).toBe('agents');
    expect(afterVeto.result.map((option) => option.id)).toEqual(['haven']);
    // Карты кончились — теперь предлагают агентов, и карту забанить уже нельзя.
    expect(afterVeto.available.map((option) => option.id)).toEqual(['jett', 'sage', 'omen', 'sova']);
    expect(canChoose(afterVeto, 'a', 'haven')).toEqual({ ok: false, reason: 'Этот вариант уже занят.' });
  });

  it('фазы отчитываются каждая за себя', () => {
    const afterVeto = draftView(pool, sequence, choose(sequence, ['ascent', 'bind']), 'maps');

    expect(afterVeto.phases.map((phase) => ({ group: phase.group, total: phase.total, done: phase.done }))).toEqual([
      { group: 'maps', total: 2, done: 2 },
      { group: 'agents', total: 4, done: 0 },
    ]);
  });

  it('в итоге и карта, и взятые агенты', () => {
    const full = draftView(pool, sequence, choose(sequence, ['ascent', 'bind', 'jett', 'sage', 'omen', 'sova']), 'maps');

    expect(full.done).toBe(true);
    // Карта из остатка, агенты — только выбранные: забаненные Jett и Sage в итог не попали.
    expect(full.result.map((option) => option.id)).toEqual(['haven', 'omen', 'sova']);
  });

  it('автоход на фазе агентов берёт агента, а не карту', () => {
    const atAgentPick = draftView(pool, sequence, choose(sequence, ['ascent', 'bind', 'jett', 'sage']), 'maps');

    expect(atAgentPick.current?.kind).toBe('pick');
    expect(autoChoice(atAgentPick)).toBe('omen');
  });
});

describe('драфты, заведённые до появления фаз', () => {
  /**
   * У старых записей набора нет ни у шагов, ни у вариантов. Они обязаны читаться — запись и
   * есть то, ради чего драфт заводился, и потерять её при обновлении кода недопустимо.
   */
  it('читаются по subject: шаг без набора берёт его у драфта', () => {
    const oldPool: DraftOption[] = [
      { id: 'ascent', label: 'Ascent' },
      { id: 'bind', label: 'Bind' },
      { id: 'haven', label: 'Haven' },
    ];
    const oldSequence: DraftStep[] = [
      { side: 'a', kind: 'ban' },
      { side: 'b', kind: 'ban' },
    ];

    const view = draftView(oldPool, oldSequence, choose(oldSequence, ['ascent', 'bind']), 'maps');

    expect(view.done).toBe(true);
    expect(view.result.map((option) => option.id)).toEqual(['haven']);
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
