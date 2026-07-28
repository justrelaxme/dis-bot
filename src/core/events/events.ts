/**
 * Карта событий бота: имя → тип полезной нагрузки.
 *
 * Модули не импортируют друг друга — они публикуют и слушают события отсюда.
 * Добавляя событие, добавляй его сюда, а не в свой модуль.
 */
export interface BotEvents {
  'core.ready': { at: Date };

  'account.linked': { userId: string; provider: string; externalId: string; verified: boolean };
  'account.unlinked': { userId: string; provider: string };
  'rank.changed': {
    userId: string;
    provider: string;
    mode: string;
    previous: { tier: string | null; division: string | null } | null;
    current: { tier: string | null; division: string | null };
  };
}
