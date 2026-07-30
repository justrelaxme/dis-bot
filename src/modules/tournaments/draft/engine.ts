import type { DraftKind, DraftOption, DraftSide, DraftStep } from './pools.js';

/**
 * Движок драфта: чистая логика поверх последовательности шагов и уже сделанных выборов.
 * Ни базы, ни HTTP, ни таймеров — чтобы «чей ход и что сейчас можно» проверялось тестами,
 * а не наблюдением за живым матчем, который переиграть нельзя.
 *
 * Ключевое решение: **состояние не хранится, а выводится из журнала выборов.** Хранить
 * отдельно «чей ход» значило бы держать второй источник истины рядом с самими выборами —
 * и однажды они разошлись бы, а разойдясь, оставили бы драфт в состоянии, из которого нет
 * выхода. Журнал плюс последовательность дают ход однозначно.
 */

export interface DraftChoice {
  step: number;
  side: DraftSide;
  kind: DraftKind;
  /** `null` — ход пропущен: время вышло на бане, а бан можно и не делать. */
  optionId: string | null;
}

export interface DraftView {
  /** Номер текущего шага, с нуля. Равен числу сделанных выборов. */
  step: number;
  /** Текущий шаг или null, если драфт закончен. */
  current: DraftStep | null;
  done: boolean;
  banned: string[];
  pickedA: string[];
  pickedB: string[];
  /** Что ещё можно выбрать. */
  available: DraftOption[];
  /**
   * Итог: то, что осталось после всех банов и было выбрано. Для карт с одним матчем это
   * единственная оставшаяся карта, для трёх — выбранные плюс решающая.
   */
  result: DraftOption[];
}

export function draftView(
  pool: readonly DraftOption[],
  sequence: readonly DraftStep[],
  choices: readonly DraftChoice[],
): DraftView {
  const banned = choices.filter((c) => c.kind === 'ban' && c.optionId !== null).map((c) => c.optionId as string);
  const pickedA = choices
    .filter((c) => c.kind === 'pick' && c.side === 'a' && c.optionId !== null)
    .map((c) => c.optionId as string);
  const pickedB = choices
    .filter((c) => c.kind === 'pick' && c.side === 'b' && c.optionId !== null)
    .map((c) => c.optionId as string);

  const taken = new Set([...banned, ...pickedA, ...pickedB]);
  const available = pool.filter((option) => !taken.has(option.id));

  const step = choices.length;
  const current = step < sequence.length ? (sequence[step] ?? null) : null;
  const done = current === null;

  // Итог: выбранное командами плюс то, что уцелело после всех банов. Уцелевшее — это и
  // есть решающая карта, и её никто не выбирал, поэтому она вне спора.
  const chosen = [...pickedA, ...pickedB];
  const result = done
    ? pool.filter((option) => chosen.includes(option.id) || !taken.has(option.id))
    : [];

  return { step, current, done, banned, pickedA, pickedB, available, result };
}

export type DraftRefusal =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Можно ли этой стороне сделать этот выбор прямо сейчас. Проверок три, и все обязательны:
 * драфт не закончен, ход этой стороны, вариант ещё свободен. Без проверки хода капитан
 * мог бы забанить за соперника, а это хуже отсутствия драфта.
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

  if (!view.available.some((option) => option.id === optionId)) {
    return { ok: false, reason: 'Этот вариант уже занят.' };
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
