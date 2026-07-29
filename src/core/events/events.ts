/**
 * Карта событий бота: имя → тип полезной нагрузки.
 *
 * Модули не импортируют друг друга — они публикуют и слушают события отсюда.
 * Добавляя событие, добавляй его сюда, а не в свой модуль.
 */
export interface BotEvents {
  'core.ready': { at: Date };

  // guildId есть у всех событий, кроме core.ready: подписчик обязан знать, на каком сервере
  // это произошло. Без него прогрессия не может начислить опыт — счёт ведётся по серверам.
  'account.linked': {
    guildId: string;
    userId: string;
    provider: string;
    externalId: string;
    verified: boolean;
  };
  'account.unlinked': { guildId: string; userId: string; provider: string };
  'rank.changed': {
    userId: string;
    provider: string;
    mode: string;
    previous: { tier: string | null; division: string | null } | null;
    current: { tier: string | null; division: string | null };
  };

  'tournament.created': { guildId: string; tournamentId: number; game: string };
  'tournament.started': { guildId: string; tournamentId: number; entrants: number };
  /**
   * `winnerUserIds` — состав победителя списком, а не идентификатор участника: подписчику
   * (прогрессии) нужны люди, которым начислять, и лезть за ними в таблицы турниров он бы
   * не смог — модули друг друга не импортируют.
   */
  'tournament.finished': {
    guildId: string;
    tournamentId: number;
    winnerEntrantId: number;
    winnerUserIds: string[];
  };
  'match.confirmed': { guildId: string; tournamentId: number; matchId: number; winnerEntrantId: number };
}
