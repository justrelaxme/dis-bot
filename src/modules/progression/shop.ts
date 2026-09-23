import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { UserError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { ProgressionService } from './service.js';

/**
 * Та часть участника Discord, которой пользуется покупка. Узко, а не весь GuildMember:
 * так видно, что покупка трогает только роли, и её можно проверить без Discord.
 */
export interface ShopMember {
  roles: {
    cache: { has(roleId: string): boolean };
    add(roleId: string, reason?: string): Promise<unknown>;
    remove(roleId: string, reason?: string): Promise<unknown>;
  };
  guild: { members: { me: { permissions: { has(permission: bigint): boolean } } | null } };
}

export interface ShopItem {
  id: number;
  /** Id роли. */
  payload: string;
  price: number;
}

/**
 * Почему Discord не выдал роль — словами, которые передадут администратору. 50013
 * означает и отсутствие права, и роль выше бота; различаем по правам бота, иначе человек
 * понесёт администратору не ту причину.
 */
export function roleGrantFailure(error: unknown, member: ShopMember): string {
  if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownRole) {
    return 'Роли этого товара на сервере больше нет — администратору нужно убрать его из магазина.';
  }
  if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingPermissions) {
    return member.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)
      ? 'Роль бота стоит ниже продаваемой, а выше своей Discord выдавать не даёт — администратору нужно поднять роль бота в настройках сервера.'
      : 'У бота нет права «Управление ролями» — администратору нужно выдать его роли бота.';
  }
  return 'Discord не дал выдать роль — попробуй ещё раз чуть позже.';
}

/**
 * Покупка роли: сначала роль, потом деньги.
 *
 * Обратный порядок брал монеты за то, что Discord мог и не выдать, — а отказ выдачи
 * глотался, и человек оставался без монет и без роли, не узнав почему. Теперь отказ
 * выдачи — это отказ покупки с причиной, и ничего не списано.
 *
 * Списание после выдачи может не пройти: между проверкой баланса и списанием монеты
 * успела съесть другая покупка. Тогда выданную роль снимаем обратно — но только если её не
 * было до покупки: продление уже купленного не должно отнимать то, за что заплачено раньше.
 */
export async function purchaseRole(input: {
  progression: Pick<ProgressionService, 'profile' | 'buy'>;
  guildId: string;
  userId: string;
  member: ShopMember;
  item: ShopItem;
  logger: Logger;
}) {
  const { progression, guildId, userId, member, item, logger } = input;

  // Проверка до выдачи — чтобы не надевать роль тому, кому её заведомо не на что купить.
  // Последнее слово всё равно за условным списанием: баланс мог измениться после чтения.
  const before = await progression.profile(guildId, userId);
  if (before.coins < item.price) {
    throw new UserError(`Не хватает монет: нужно ${item.price}, у тебя ${before.coins}.`);
  }

  const had = member.roles.cache.has(item.payload);
  if (!had) {
    try {
      await member.roles.add(item.payload, 'Покупка в магазине');
    } catch (error) {
      logger.warn({ err: error, roleId: item.payload }, 'роль из магазина не выдалась');
      throw new UserError(`${roleGrantFailure(error, member)} Монеты не списаны.`);
    }
  }

  try {
    return await progression.buy(guildId, userId, item.id);
  } catch (error) {
    if (!had) {
      await member.roles
        .remove(item.payload, 'Покупка не оплачена')
        .catch((removeError: unknown) =>
          logger.warn({ err: removeError, roleId: item.payload }, 'не удалось снять неоплаченную роль'),
        );
    }
    throw error;
  }
}
