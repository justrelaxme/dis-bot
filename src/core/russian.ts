/**
 * Согласование существительного с числом по правилам русского языка: «1 матч»,
 * «2 матча», «5 матчей». Второй десяток разбирается отдельно — «11 матчей», а не
 * «11 матч», потому что правило по последней цифре там не работает.
 *
 * Живёт в ядре, а не в модуле: это про язык, а не про предметную область, и нужно всем.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const hundredRemainder = Math.abs(count) % 100;
  if (hundredRemainder >= 11 && hundredRemainder <= 14) return many;

  const tenRemainder = hundredRemainder % 10;
  if (tenRemainder === 1) return one;
  if (tenRemainder >= 2 && tenRemainder <= 4) return few;
  return many;
}
