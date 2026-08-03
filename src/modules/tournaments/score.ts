/**
 * Счёт матча: разбор строки и проверка на согласие с названным победителем.
 *
 * Счёт бот проверить не может — ни одна из поддерживаемых игр не отдаёт результат кастомного
 * матча наружу. Поэтому он **необязателен**: требовать поле, которое всё равно вводят руками,
 * значит ставить участника перед выбором между «наврал» и «не смог отчитаться». Победителя
 * называют отдельно, а счёт его только поясняет.
 *
 * Но если счёт назван, он обязан не противоречить победителю. Строка «2:1» рядом с победой
 * второй команды — это либо опечатка, либо попытка подправить историю, и в обоих случаях
 * пропускать её нельзя: в сетке и зале славы она останется навсегда.
 */

/** Разумный предел: 13 раундов в Valorant, 3 карты в серии. Сотня — уже опечатка. */
const MAX_SCORE = 99;

export interface MatchScore {
  a: number;
  b: number;
}

export type ScoreParse =
  | { ok: true; score: MatchScore }
  | { ok: false; reason: string };

/**
 * Разбирает счёт из строки. Принимаются разделители, которые человек действительно набирает:
 * двоеточие, дефис, тире. Пробелы вокруг допустимы.
 */
export function parseScore(raw: string): ScoreParse {
  const match = /^\s*(\d{1,2})\s*[:\-–—]\s*(\d{1,2})\s*$/.exec(raw);
  if (!match) {
    return { ok: false, reason: 'Счёт пишется как «13:8» или «2-1».' };
  }

  const a = Number.parseInt(match[1] ?? '', 10);
  const b = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return { ok: false, reason: 'Счёт пишется как «13:8» или «2-1».' };
  }
  if (a > MAX_SCORE || b > MAX_SCORE) {
    return { ok: false, reason: `Больше ${MAX_SCORE} в счёте не бывает — похоже на опечатку.` };
  }
  if (a === b) {
    // Ничья невозможна: у матча есть победитель, иначе он не закрывается.
    return { ok: false, reason: 'Ничьей в матче быть не может — у него есть победитель.' };
  }

  return { ok: true, score: { a, b } };
}

/**
 * Согласуется ли счёт с названным победителем. Возвращает `null`, если всё в порядке, и текст
 * отказа, если нет: у победителя должно быть больше.
 */
export function scoreDisagrees(
  score: MatchScore,
  winnerSide: 'a' | 'b',
  names: { a: string; b: string },
): string | null {
  const winnerLeads = winnerSide === 'a' ? score.a > score.b : score.b > score.a;
  if (winnerLeads) return null;

  const leader = score.a > score.b ? names.a : names.b;
  const winner = winnerSide === 'a' ? names.a : names.b;
  return `Счёт ${score.a}:${score.b} говорит, что выиграл ${leader}, а победителем указан ${winner}. Проверь, что перепутано.`;
}

/** Как показать счёт. Пусто, если его не вводили: придумывать его нельзя. */
export function formatScore(a: number | null, b: number | null): string {
  if (a === null || b === null) return '';
  return `${a}:${b}`;
}
