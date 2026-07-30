import type { Client } from 'discord.js';
import { plural } from '../../core/russian.js';
import type { ProgressionService, SeasonAward, SeasonClosing } from './service.js';

/**
 * Доведение закрытого сезона до людей: роль чемпиона и объявление в канал.
 *
 * Живёт отдельно от команды, потому что закрывать сезон умеют двое — администратор руками
 * (`/progression season`) и джоба по расписанию. Если бы эта логика осталась в обработчике
 * команды, автоматическая смена сезона молча не переносила бы роль и не объявляла итогов,
 * то есть выглядела бы как обнуление без награды — ровно то, от чего награды и заводились.
 */

/** Медали для первых трёх мест: дальше номер понятнее любого значка. */
export const PLACE_MARKS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

export function awardLine(award: SeasonAward): string {
  const coins = `${award.coins} ${plural(award.coins, 'монета', 'монеты', 'монет')}`;
  return `${PLACE_MARKS[award.place] ?? `${award.place}.`} <@${award.userId}> — ${award.xp} опыта, +${coins}`;
}

/**
 * Переносит роль чемпиона и объявляет итоги. Возвращает строки отчёта для того, кто
 * закрытие затеял: администратору они уходят ответом на команду, джоба пишет их в лог.
 */
export async function applySeasonClosing(deps: {
  client: Client;
  guildId: string;
  closing: SeasonClosing;
  progression: ProgressionService;
}): Promise<string[]> {
  const { client, guildId, closing, progression } = deps;

  const lines = [
    `Начался сезон «${closing.season.name}». Зачёт с нуля, достижения и история остались.`,
  ];

  if (closing.awarded.length === 0) {
    lines.push('', 'Награждать было некого: в прошлом сезоне никто не набрал опыта.');
  } else {
    lines.push('', `**Итоги «${closing.previous.name}»**`, ...closing.awarded.map(awardLine));
    lines.push('', 'Монеты начислены в новый сезон — в закрытом они бы уже не пригодились.');
  }

  // Роль чемпиона — текущий статус, поэтому переезжает: надеваем новому, снимаем с
  // прежнего. Постоянный след оставляет достижение, а не роль.
  const champion = closing.awarded.find((award) => award.place === 1);
  const guild = closing.championRoleId
    ? await client.guilds.fetch(guildId).catch(() => null)
    : null;

  if (closing.championRoleId && guild) {
    const role = await guild.roles.fetch(closing.championRoleId).catch(() => null);
    if (!role) {
      lines.push('', 'Роль чемпиона настроена, но на сервере не найдена — задайте заново.');
    } else {
      const prior = await progression.priorChampion(guildId, closing.previous.id);
      if (prior && prior !== champion?.userId) {
        const member = await guild.members.fetch(prior).catch(() => null);
        await member?.roles.remove(role).catch(() => undefined);
      }
      if (champion) {
        const member = await guild.members.fetch(champion.userId).catch(() => null);
        const granted = member
          ? await member.roles
              .add(role)
              .then(() => true)
              .catch(() => false)
          : false;
        lines.push(
          '',
          granted
            ? `Роль **${role.name}** перешла к <@${champion.userId}>.`
            : `Роль **${role.name}** выдать не удалось — скорее всего, она стоит выше роли бота.`,
        );
      }
    }
  }

  // Итоги объявляем публично, если задан канал: ответ администратору видит только он, а
  // награду показывают серверу — иначе непонятно, за что человек получил роль.
  const config = await progression.seasonRewardConfig(guildId);
  if (config.announceChannelId && closing.awarded.length > 0) {
    const channel = await client.channels.fetch(config.announceChannelId).catch(() => null);
    if (channel?.isSendable()) {
      await channel
        .send({
          content: [
            `## Сезон «${closing.previous.name}» закрыт`,
            ...closing.awarded.map(awardLine),
            '',
            `Начался «${closing.season.name}» — зачёт с нуля, у всех равные шансы. \`/top\` покажет таблицу.`,
          ].join('\n'),
        })
        .catch(() => undefined);
    }
  }

  return lines;
}
