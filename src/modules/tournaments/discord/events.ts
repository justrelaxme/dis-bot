import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Guild,
} from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import type { TournamentRow } from '../schema.js';

/**
 * Событие Discord как афиша турнира.
 *
 * Оно **дублирует** объявление, а не заменяет его, и это осознанный выбор. Событие умеет то,
 * чего не умеет сообщение: попадает во вкладку «События», само напоминает подписавшимся,
 * показывает отсчёт до старта и собирает «Интересно» — то есть отвечает на вопрос «когда» без
 * пролистывания чата. Но кнопок в нём нет и живых обновлений тоже, поэтому регистрация
 * остаётся панелью с кнопками, а драфт — страницей. Заменить одно другим значило бы потерять
 * либо напоминания, либо возможность записаться.
 *
 * Ни один сбой здесь не должен влиять на турнир. Права «Управление событиями» у бота может не
 * быть, и это нормальное состояние сервера: тогда афиши просто не будет, а вечер пройдёт как
 * обычно. Поэтому всё завёрнуто в try и наверх уходит `null`, а не исключение.
 */

/** Сколько длится событие. Discord требует конец у внешнего события, а турнир идёт вечер. */
const EVENT_HOURS = 4;

function canManage(guild: Guild): boolean {
  return guild.members.me?.permissions.has(PermissionFlagsBits.ManageEvents) ?? false;
}

function describe(tournament: TournamentRow, bracketUrl: string): string {
  const game = TOURNAMENT_GAME_LABELS[tournament.game] ?? tournament.game;
  const roster =
    tournament.entryMode === 'solo'
      ? `Один на один${tournament.abilities ? '' : ', способности выключены'}`
      : `Команды по ${tournament.teamSize}`;

  return [
    `${game} · ${roster}`,
    tournament.format === 'double-elim'
      ? 'Двойное устранение: одно поражение — ещё не конец.'
      : 'На выбывание: одно поражение и всё.',
    '',
    'Записаться — кнопкой под объявлением в канале турнира.',
    `Сетка: ${bracketUrl}`,
  ].join('\n');
}

export interface TournamentEventsGateway {
  /** Создаёт афишу и возвращает её идентификатор. `null` — не получилось, и это не ошибка. */
  announce(
    guild: Guild,
    tournament: TournamentRow,
    startsAt: Date,
    bracketUrl: string,
  ): Promise<string | null>;
  /** Переводит афишу в «идёт». */
  begin(guild: Guild, eventId: string): Promise<void>;
  /** Закрывает афишу и дописывает победителя. */
  finish(guild: Guild, eventId: string, champion: string | null): Promise<void>;
  /** Отменяет афишу вместе с турниром. */
  cancel(guild: Guild, eventId: string): Promise<void>;
}

export function createTournamentEventsGateway(logger: Logger): TournamentEventsGateway {
  /** Общая обёртка: сбой афиши никогда не должен трогать турнир. */
  async function attempt<T>(what: string, action: () => Promise<T>): Promise<T | null> {
    try {
      return await action();
    } catch (error) {
      logger.warn({ err: error }, `афиша турнира: ${what}`);
      return null;
    }
  }

  return {
    async announce(guild, tournament, startsAt, bracketUrl): Promise<string | null> {
      if (!canManage(guild)) {
        logger.info({ guildId: guild.id }, 'афиши турнира не будет: нет права «Управление событиями»');
        return null;
      }

      // Начало не раньше, чем через минуту: Discord отклоняет событие в прошлом, а
      // регистрация может открыться уже после назначенного времени старта.
      const begins = new Date(Math.max(startsAt.getTime(), Date.now() + 60_000));

      const event = await attempt('не удалось создать', () =>
        guild.scheduledEvents.create({
          name: tournament.name,
          description: describe(tournament, bracketUrl),
          scheduledStartTime: begins,
          scheduledEndTime: new Date(begins.getTime() + EVENT_HOURS * 60 * 60 * 1_000),
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          // Внешнее событие, а не голосовой канал: турнир играют в игре, а комнаты команд
          // создаются только после жеребьёвки — привязать афишу к одной из них нельзя.
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: { location: bracketUrl },
        }),
      );

      return event?.id ?? null;
    },

    async begin(guild, eventId): Promise<void> {
      await attempt('не удалось перевести в «идёт»', async () => {
        const event = await guild.scheduledEvents.fetch(eventId);
        if (event.status === GuildScheduledEventStatus.Scheduled) {
          await event.setStatus(GuildScheduledEventStatus.Active);
        }
      });
    },

    async finish(guild, eventId, champion): Promise<void> {
      await attempt('не удалось закрыть', async () => {
        const event = await guild.scheduledEvents.fetch(eventId);

        // Победитель дописывается в описание: афиша остаётся в списке прошедших событий, и
        // без него она не отвечает на единственный вопрос, который к ней потом приходят.
        if (champion) {
          await event.setDescription(`🏆 Победитель — ${champion}\n\n${event.description ?? ''}`.trim());
        }

        // Закрыть можно только идущее. Если событие ещё «запланировано» — сначала начинаем:
        // турнир, доигранный раньше назначенного часа, иначе остался бы висеть афишей.
        if (event.status === GuildScheduledEventStatus.Scheduled) {
          await event.setStatus(GuildScheduledEventStatus.Active);
        }
        const refreshed = await guild.scheduledEvents.fetch(eventId);
        if (refreshed.status === GuildScheduledEventStatus.Active) {
          await refreshed.setStatus(GuildScheduledEventStatus.Completed);
        }
      });
    },

    async cancel(guild, eventId): Promise<void> {
      await attempt('не удалось отменить', async () => {
        const event = await guild.scheduledEvents.fetch(eventId);
        // Отменить можно только незапущенное; идущее закрывается как завершённое.
        await event.setStatus(
          event.status === GuildScheduledEventStatus.Scheduled
            ? GuildScheduledEventStatus.Canceled
            : GuildScheduledEventStatus.Completed,
        );
      });
    },
  };
}
