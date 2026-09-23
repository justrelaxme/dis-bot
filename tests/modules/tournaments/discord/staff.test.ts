import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { isOrganizer, staffAlert } from '../../../../src/modules/tournaments/discord/staff.js';

/**
 * Позвать организатора. Спор раньше висел в закрытой ветке матча, пока кто-нибудь случайно
 * туда не заглянет, — правило «отказ виден тому, кто может его исправить» не исполнялось.
 */

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

const settingsRow = (over: Partial<{ organizerRoleId: string | null; staffChannelId: string | null }> = {}) => ({
  guildId: 'g',
  organizerRoleId: null,
  staffChannelId: null,
  updatedAt: new Date(),
  ...over,
});

describe('кто организатор', () => {
  const member = (perms: bigint[], roles: string[]) => ({
    permissions: { has: (flag: bigint) => perms.includes(flag) },
    roles: { cache: { has: (id: string) => roles.includes(id) } },
  });

  it('«Управление сервером» — организатор всегда', () => {
    expect(isOrganizer(member([PermissionFlagsBits.ManageGuild], []), null)).toBe(true);
  });

  it('роль организаторов даёт то же право без «Управления сервером»', () => {
    expect(isOrganizer(member([], ['role-org']), settingsRow({ organizerRoleId: 'role-org' }))).toBe(true);
  });

  it('без права и без роли — не организатор', () => {
    expect(isOrganizer(member([], ['role-other']), settingsRow({ organizerRoleId: 'role-org' }))).toBe(false);
    expect(isOrganizer(member([], ['role-org']), null)).toBe(false);
  });

  /** Участник из интеракции без кэша приходит сырым: права строкой, роли массивом. */
  it('понимает и сырого участника из интеракции', () => {
    expect(isOrganizer({ permissions: '0', roles: ['role-org'] }, settingsRow({ organizerRoleId: 'role-org' }))).toBe(true);
  });

  it('без участника — не организатор', () => {
    expect(isOrganizer(null, null)).toBe(false);
  });
});

function guildWith(channels: Record<string, { sendable: boolean; fails?: boolean }>) {
  const sent: Array<{ channelId: string; content: string; allowedMentions: unknown }> = [];
  const dms: string[] = [];
  const guild = {
    id: 'g',
    ownerId: 'owner-1',
    channels: {
      fetch: vi.fn(async (id: string) => {
        const channel = channels[id];
        if (!channel) return null;
        return {
          isSendable: () => channel.sendable,
          send: vi.fn(async (payload: { content: string; allowedMentions: unknown }) => {
            if (channel.fails) throw new Error('Missing Access');
            sent.push({ channelId: id, ...payload });
          }),
        };
      }),
    },
    fetchOwner: vi.fn(async () => ({
      send: vi.fn(async (text: string) => {
        dms.push(text);
      }),
    })),
  };
  return { guild: guild as never, sent, dms };
}

const tournament = { announceChannelId: 'announce' } as never;

describe('сигнал в штаб', () => {
  it('уходит в канал штаба с упоминанием роли организаторов', async () => {
    const { guild, sent } = guildWith({ staff: { sendable: true }, announce: { sendable: true } });
    const settings = { get: vi.fn(async () => settingsRow({ organizerRoleId: 'role-org', staffChannelId: 'staff' })) };

    await expect(staffAlert({ settings, logger }, guild, { text: 'спор', tournament })).resolves.toBe('sent');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe('staff');
    expect(sent[0]?.content).toContain('<@&role-org>');
    expect(sent[0]?.allowedMentions).toEqual({ roles: ['role-org'] });
  });

  /** Сказать не туда лучше, чем не сказать: канал штаба закрыт — значит в канал объявлений. */
  it('канал штаба недоступен — уходит в канал объявлений турнира', async () => {
    const { guild, sent } = guildWith({ staff: { sendable: true, fails: true }, announce: { sendable: true } });
    const settings = { get: vi.fn(async () => settingsRow({ staffChannelId: 'staff' })) };

    await expect(staffAlert({ settings, logger }, guild, { text: 'спор', tournament })).resolves.toBe('sent');

    expect(sent.map((message) => message.channelId)).toEqual(['announce']);
    // Роли нет — зовём владельца.
    expect(sent[0]?.content).toContain('<@owner-1>');
  });

  it('каналов нет — владельцу в личку, с подсказкой, как задать штаб', async () => {
    const { guild, sent, dms } = guildWith({});
    const settings = { get: vi.fn(async () => null) };

    await expect(staffAlert({ settings, logger }, guild, { text: 'спор' })).resolves.toBe('sent');

    expect(sent).toHaveLength(0);
    expect(dms[0]).toContain('/tournament settings');
  });

  /** Джобы тикают раз в минуту: один и тот же сигнал не должен приходить каждую минуту. */
  it('повтор с тем же ключом внутри окна гасится', async () => {
    const { guild, sent } = guildWith({ staff: { sendable: true } });
    const settings = { get: vi.fn(async () => settingsRow({ staffChannelId: 'staff' })) };
    const counts = new Map<string, number>();
    const cache = {
      incrementInWindow: vi.fn(async (key: string) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key) ?? 0;
      }),
    };

    await staffAlert({ settings, cache, logger }, guild, { text: 'спор', dedupeKey: 'dispute:1' });
    await expect(staffAlert({ settings, cache, logger }, guild, { text: 'спор', dedupeKey: 'dispute:1' })).resolves.toBe(
      'deduped',
    );
    await staffAlert({ settings, cache, logger }, guild, { text: 'другой спор', dedupeKey: 'dispute:2' });

    expect(sent).toHaveLength(2);
  });
});
