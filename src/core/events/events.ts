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
    /**
     * Ранг вырос по сравнению с прошлым снимком. Считает тот, кто умеет сравнивать ранги, —
     * модуль личности; подписчику (прогрессии) незачем знать шкалы всех игр. Первый снимок
     * после привязки ростом не считается: расти было не от чего.
     */
    climbed: boolean;
  };

  'tournament.created': { guildId: string; tournamentId: number; game: string };
  /**
   * Турнир стартовал. Люди — списками, как и у `tournament.finished`: прогрессии нужны те,
   * кому начислять. `captainUserIds` — только капитаны команд, собранных руками: капитан,
   * которого назначил автосбор, команду не собирал.
   */
  'tournament.started': {
    guildId: string;
    tournamentId: number;
    entrants: number;
    participantUserIds: string[];
    captainUserIds: string[];
  };
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
  /**
   * События матча. Публикует их только сервис турниров и только после успешного перехода в
   * базе (CAS): повторное нажатие, повторная доставка и гонка джобы с кнопкой дают одно
   * событие, а не два. Слушатели — живая витрина и всё, что должно реагировать на ход
   * вечера, не зная, каким путём матч до этого дошёл.
   */
  'match.ready': { guildId: string; tournamentId: number; matchId: number };
  'match.reported': { guildId: string; tournamentId: number; matchId: number; winnerEntrantId: number };
  'match.disputed': { guildId: string; tournamentId: number; matchId: number };
  /**
   * Обе стороны нажали «На месте» (или организатор запустил матч сам). С этого момента идёт
   * таймер драфта и закрыт приём прогнозов: видя пики, угадывать уже нечестно.
   */
  'match.live': { guildId: string; tournamentId: number; matchId: number };
  'match.confirmed': {
    guildId: string;
    tournamentId: number;
    matchId: number;
    winnerEntrantId: number;
    /** Каким путём закрыт: кнопкой соперника, молчанием, проверкой Dota, организатором, пропуском в сетке. */
    via: 'confirm' | 'auto-confirm' | 'verified' | 'resolve' | 'walkover' | 'bye';
    /** Этот матч закрыл турнир. */
    finished: boolean;
  };
  /**
   * Организатор исправил закрытый результат. Прогнозы на этот матч пересчитываются, витрина
   * перечитывает сетку: победитель в следующем матче уже другой.
   */
  'match.corrected': {
    guildId: string;
    tournamentId: number;
    matchId: number;
    winnerEntrantId: number;
    previousWinnerId: number;
  };
  /**
   * Матч пересобирается с другой парой (исправили результат предыдущего): всё, что было
   * привязано к прежней паре — прогнозы, карточки, — сбрасывается. Слушатели обязаны успеть
   * до того, как матч снова станет играбельным: событие публикуется раньше.
   */
  'match.reset': { guildId: string; tournamentId: number; matchId: number };
  'tournament.cancelled': { guildId: string; tournamentId: number };
  /** Кастер переключил сцену или главный матч трансляции: открытая сцена перечитывает себя. */
  'cast.changed': { guildId: string; tournamentId: number };
  /** Кто-то записался, вышел или отметился: во время регистрации витрина показывает список. */
  'tournament.entrants': { guildId: string; tournamentId: number };
  /** Ход драфта или его создание: витрина перечитывает полотно. */
  'draft.changed': { guildId: string; tournamentId: number; matchId: number; done: boolean };
}
