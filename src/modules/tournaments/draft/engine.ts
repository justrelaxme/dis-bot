import {
  picksBlockOpponent,
  survivorsAreResult,
  type DraftGroup,
  type DraftKind,
  type DraftOption,
  type DraftSide,
  type DraftStep,
} from './pools.js';

/**
 * Движок драфта: чистая логика поверх последовательности шагов и уже сделанных выборов.
 * Ни базы, ни HTTP, ни таймеров — чтобы «чей ход и что сейчас можно» проверялось тестами,
 * а не наблюдением за живым матчем, который переиграть нельзя.
 *
 * Ключевое решение: **состояние не хранится, а выводится из журнала выборов.** Хранить
 * отдельно «чей ход» значило бы держать второй источник истины рядом с самими выборами —
 * и однажды они разошлись бы, а разойдясь, оставили бы драфт в состоянии, из которого нет
 * выхода. Журнал плюс последовательность дают ход однозначно.
 *
 * Драфт идёт **фазами** — у Valorant сначала карты, потом агенты. Фаза кончается сама,
 * когда кончаются её шаги, и её итог виден сразу: карту надо знать до того, как выберут
 * агентов, иначе выбирать агентов не под что.
 */

export interface DraftChoice {
  step: number;
  side: DraftSide;
  kind: DraftKind;
  /** `null` — ход пропущен: время вышло на бане, а бан можно и не делать. */
  optionId: string | null;
}

export interface DraftPhase {
  group: DraftGroup | undefined;
  /** Сколько шагов в фазе и сколько из них пройдено. */
  total: number;
  done: number;
  /** Итог фазы. Пуст, пока фаза не закончена. */
  result: DraftOption[];
}

export interface DraftView {
  /** Номер текущего шага, с нуля. Равен числу сделанных выборов. */
  step: number;
  /** Текущий шаг или null, если драфт закончен. */
  current: DraftStep | null;
  /** Из какого набора выбирают сейчас. null — драфт закончен. */
  group: DraftGroup | undefined;
  done: boolean;
  banned: string[];
  pickedA: string[];
  pickedB: string[];
  /** Что ещё можно выбрать — только из набора текущей фазы. */
  available: DraftOption[];
  /**
   * Кто заявил состав сам. От этого зависит, ограничены ли пики заявкой: заявлялся — да,
   * не заявлялся — драфт идёт по общему пулу, как у остальных дисциплин.
   *
   * Считается из пула, а не по доступному: заявленное могло быть уже взято, и по остатку
   * заявка выглядела бы отсутствующей.
   */
  declaredSides: DraftSide[];
  phases: DraftPhase[];
  /**
   * Итог законченных фаз: выбранное командами плюс уцелевшее там, где уцелевшее считается
   * итогом. Для карт с одним матчем это единственная оставшаяся карта, для трёх — выбранные
   * плюс решающая, для героев и агентов — только выбранное.
   */
  result: DraftOption[];
}

/**
 * Относится ли вариант к набору. Вариант без набора относится к любому, и шаг без набора
 * выбирает из всего: так читаются драфты, заведённые до появления фаз, — а прошлые записи
 * и есть то, ради чего драфт заводился.
 */
function inGroup(option: DraftOption, group: DraftGroup | undefined): boolean {
  if (group === undefined || option.group === undefined) return true;
  return option.group === group;
}

export function draftView(
  pool: readonly DraftOption[],
  sequence: readonly DraftStep[],
  choices: readonly DraftChoice[],
  /** Набор для шагов без пометки: `subject` строки драфта. */
  fallbackGroup?: DraftGroup,
): DraftView {
  const groupOf = (step: DraftStep): DraftGroup | undefined => step.group ?? fallbackGroup;

  const banned = choices.filter((c) => c.kind === 'ban' && c.optionId !== null).map((c) => c.optionId as string);
  const pickedA = choices
    .filter((c) => c.kind === 'pick' && c.side === 'a' && c.optionId !== null)
    .map((c) => c.optionId as string);
  const pickedB = choices
    .filter((c) => c.kind === 'pick' && c.side === 'b' && c.optionId !== null)
    .map((c) => c.optionId as string);

  const taken = new Set([...banned, ...pickedA, ...pickedB]);

  const step = choices.length;
  const current = step < sequence.length ? (sequence[step] ?? null) : null;
  const done = current === null;
  const group = current === null ? undefined : groupOf(current);

  /**
   * Что занято **для этой стороны**. Бан занимает вариант всегда: он общий. Пик занимает его
   * у соперника только там, где играют одним и тем же, — то есть у карт. Героя, взятого
   * соперником, взять можно: чужой пик виден, и под него берут контрпик, в этом и смысл.
   */
  const blockedFor = (side: DraftSide, forGroup: DraftGroup | undefined): Set<string> => {
    const own = side === 'a' ? pickedA : pickedB;
    if (forGroup !== undefined && !picksBlockOpponent(forGroup)) {
      return new Set([...banned, ...own]);
    }
    return taken;
  };

  const blocked = current === null ? taken : blockedFor(current.side, group);
  const available = pool.filter((option) => !blocked.has(option.id) && inGroup(option, group));

  // Фазы идут подряд: шаги одного набора не перемешаны с шагами другого. Поэтому пройденное
  // в фазе — это просто число сделанных выборов минус то, что осталось за её началом.
  const chosen = new Set([...pickedA, ...pickedB]);
  const phases: DraftPhase[] = [];
  let offset = 0;
  while (offset < sequence.length) {
    const phaseGroup = groupOf(sequence[offset] as DraftStep);
    let end = offset;
    while (end < sequence.length && groupOf(sequence[end] as DraftStep) === phaseGroup) end += 1;

    const total = end - offset;
    const phaseDone = Math.min(Math.max(step - offset, 0), total);
    const finished = phaseDone === total;

    // Итог фазы виден только когда фаза закончена: половина вето — это ещё не карта.
    const result = finished
      ? pool.filter(
          (option) =>
            inGroup(option, phaseGroup) &&
            (chosen.has(option.id) ||
              (phaseGroup !== undefined && survivorsAreResult(phaseGroup) && !taken.has(option.id))),
        )
      : [];

    phases.push({ group: phaseGroup, total, done: phaseDone, result });
    offset = end;
  }

  return {
    step,
    current,
    group,
    done,
    banned,
    pickedA,
    pickedB,
    available,
    // Заявку могли сделать обе стороны, одна или ни одна — и от этого зависит, ограничены ли
    // пики. Считаем по всему пулу: заявленное могло быть уже взято.
    declaredSides: (['a', 'b'] as const).filter((side) =>
      pool.some((option) => option.declaredBy?.includes(side)),
    ),
    phases,
    result: phases.flatMap((phase) => phase.result),
  };
}

export type DraftRefusal =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Можно ли этой стороне сделать этот выбор прямо сейчас. Проверок три, и все обязательны:
 * драфт не закончен, ход этой стороны, вариант ещё свободен и из нужного набора. Без
 * проверки хода капитан мог бы забанить за соперника, а это хуже отсутствия драфта.
 */
export function canChoose(
  view: DraftView,
  side: DraftSide,
  optionId: string | null,
): DraftRefusal {
  if (view.done) return { ok: false, reason: 'Драфт уже закончен.' };
  if (view.current?.side !== side) return { ok: false, reason: 'Сейчас ход соперника.' };

  if (optionId === null) {
    // Пропуск разрешён только на бане: пик пропустить нельзя, иначе состав окажется
    // неполным и драфт потеряет смысл.
    return view.current.kind === 'ban'
      ? { ok: true }
      : { ok: false, reason: 'Пик пропустить нельзя — выбери вариант.' };
  }

  const option = view.available.find((entry) => entry.id === optionId);
  if (!option) {
    return { ok: false, reason: 'Этот вариант уже занят.' };
  }

  /**
   * Пик — только из заявленного, и только если игрок заявлялся.
   *
   * Заявку человек собрал своими руками и уложил в бюджет: держать его в её пределах честно, и
   * иначе бюджет обходился бы прямо в драфте. А вот состав, лишь прочитанный из Летописи,
   * запретом быть не может — HoYoLAB показывает вчерашнюю крутку с задержкой, и отнимать ход
   * из-за этой задержки нельзя. Там пометка остаётся подсказкой: плитка подписана «нет у тебя»,
   * а решение за игроком.
   *
   * Проверка стоит только на пике. Бан чужого — законный и осмысленный ход: банят как раз то,
   * что есть у соперника, а не у себя.
   */
  /**
   * Иммун соперника забанить нельзя — в этом всё правило. Своего банить тоже незачем, но
   * запрещать это отдельно не нужно: свой иммун защищён от бана любой стороной, и попытка
   * забанить его у себя означала бы просто потраченный ход.
   */
  if (view.current.kind === 'ban' && (option.immuneFor?.length ?? 0) > 0) {
    return {
      ok: false,
      reason: 'Этот персонаж под иммуном — забанить его нельзя. Взять можно: иммун защищает от бана, а не присваивает.',
    };
  }

  const declared = option.declaredBy?.includes(side) ?? false;
  if (view.current.kind === 'pick' && declared === false && view.declaredSides.includes(side)) {
    return {
      ok: false,
      reason: 'Этого персонажа нет в твоей заявке — взять его нельзя. Забанить у соперника можно.',
    };
  }

  return { ok: true };
}

/**
 * Что выбрать за того, кто не успел. Бан пропускается — не забанил значит не забанил, и
 * навязывать случайный бан было бы решением за игрока. А пик пропустить нельзя: без него
 * драфт не завершится никогда, поэтому берём первый свободный вариант.
 *
 * Первый свободный, а не случайный, намеренно: случайность в необратимом действии нельзя
 * ни проверить, ни объяснить пострадавшему. «Взяли первого из оставшихся» — можно.
 */
export function autoChoice(view: DraftView): string | null {
  if (view.done || view.current === null) return null;
  if (view.current.kind === 'ban') return null;
  return view.available[0]?.id ?? null;
}

/** Сколько всего шагов и сколько пройдено — для полосы прогресса на странице. */
export function draftProgress(sequence: readonly DraftStep[], choices: readonly DraftChoice[]): {
  total: number;
  done: number;
} {
  return { total: sequence.length, done: Math.min(choices.length, sequence.length) };
}
