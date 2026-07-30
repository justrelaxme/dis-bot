/**
 * Правила прогрессии: сколько дают, за что, и когда не дают вовсе. Чистая арифметика,
 * ни базы, ни Discord — чтобы её можно было просчитать глазами и проверить на бумаге.
 */

/** Опыт за сообщение. Немного: болтовня не должна обгонять участие в турнирах. */
export const XP_PER_MESSAGE = 4;

/**
 * Пауза между начислениями за сообщения. Без неё опыт зарабатывается флудом, и лидерборд
 * показывает не активных, а тех, кто быстрее печатает.
 */
export const MESSAGE_COOLDOWN_MS = 60 * 1_000;

/** Слишком короткое сообщение не считается: «+», «ага» и стикеры это не активность. */
export const MIN_MESSAGE_LENGTH = 3;

/** Опыт за минуту в голосовом канале. */
export const XP_PER_VOICE_MINUTE = 2;

/**
 * Одиночное сидение в канале не считается: опыт даётся за общение, а не за подключённый
 * микрофон. Начисляем только когда в канале был кто-то ещё.
 */
export const VOICE_MIN_PARTNERS = 1;

/** Потолок за одну голосовую сессию: сутки в канале не должны давать сутки опыта. */
export const VOICE_SESSION_CAP_MINUTES = 240;

export const XP_TOURNAMENT_PLAY = 60;
export const XP_TOURNAMENT_WIN = 250;
export const XP_RANK_UP = 40;

/** Валюта за уровень: тратится на роли и цвета. */
export const COINS_PER_LEVEL = 50;

/**
 * Кривая уровней. Порог растёт квадратично: `100 * уровень^1.5`, округлённо.
 *
 * Просчитаем руками, чтобы кривая не оказалась ни отвесной, ни плоской:
 * уровень 1 — 100 опыта, 5 — 1118, 10 — 3162, 20 — 8944, 50 — 35355.
 * При 4 опыта за сообщение с паузой в минуту это примерно 25 сообщений до второго уровня
 * и около 800 до десятого — то есть десятый уровень это месяц-два обычной болтовни, а
 * участие в турнирах ускоряет заметно, но не отменяет активность.
 */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  return Math.round(100 * level ** 1.5);
}

/** Уровень по накопленному опыту: наибольший, чей порог взят. */
export function levelFromXp(xp: number): number {
  if (xp < xpForLevel(1)) return 0;
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  return level;
}

/** Сколько осталось до следующего уровня — для карточки профиля. */
export function progressToNext(xp: number): { level: number; have: number; need: number } {
  const level = levelFromXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, have: xp - base, need: next - base };
}

export interface AchievementDef {
  code: string;
  title: string;
  description: string;
  /** Опыт за получение. Достижение без награды — просто надпись. */
  xp: number;
}

/**
 * Каталог достижений. Объявляется кодом, а не в базе: у достижения есть условие, а условие
 * — это код. Хранить в базе только выданные.
 *
 * Условия намеренно разные по типу: за первый шаг, за постоянство, за результат и за
 * особенность поведения. Набор из одних «сделай N раз» превращается в счётчики, за
 * которыми неинтересно следить.
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { code: 'linked', title: 'Представился', description: 'Привязал первый игровой аккаунт', xp: 50 },
  { code: 'first-tournament', title: 'Дебют', description: 'Сыграл первый турнир', xp: 100 },
  { code: 'champion', title: 'Чемпион', description: 'Выиграл турнир', xp: 300 },
  { code: 'three-peat', title: 'Серия', description: 'Выиграл три турнира', xp: 700 },
  { code: 'captain', title: 'Капитан', description: 'Собрал команду и довёл её до старта', xp: 120 },
  { code: 'level-10', title: 'Свой', description: 'Дошёл до десятого уровня', xp: 200 },
  { code: 'night-owl', title: 'Ночная смена', description: 'Писал в чат между тремя и шестью утра', xp: 60 },
  { code: 'rank-climber', title: 'Растёт', description: 'Поднял ранг в игре после привязки', xp: 80 },
  // Роль чемпиона переезжает к новому, а это остаётся навсегда: роль — текущий статус,
  // достижение — запись в истории, и одно другое не заменяет.
  { code: 'season-winner', title: 'Лучший сезона', description: 'Занял первое место в сезоне', xp: 500 },
  { code: 'season-podium', title: 'На подиуме', description: 'Вошёл в тройку сезона', xp: 200 },
];

export function achievementByCode(code: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((achievement) => achievement.code === code);
}

/** Ночная смена: с 3:00 до 5:59 включительно по местному времени сервера. */
export function isNightOwlHour(hour: number): boolean {
  return hour >= 3 && hour < 6;
}
