import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import type { PlayDeps } from '../commands/play.js';
import type { MatchRow } from '../schema.js';
import { staffAlert } from './staff.js';

/**
 * Карточка «матч готов» в ветке матча.
 *
 * До неё матч начинался молча: ветка появлялась, драфт шёл с таймером с первой секунды, и
 * капитан, открывший Discord через пять минут, находил свои баны пропущенными. Теперь в
 * ветке одно сообщение, где есть всё: кто играет (с упоминаниями — чтобы дошло до телефона),
 * где голосовые, где драфт, и кнопка **«На месте»**. Когда её нажали обе стороны, матч
 * начинается: идёт таймер драфта, закрывается приём прогнозов. Не нажали за десять минут —
 * бот зовёт организатора, а не ждёт вечно.
 */

export const BTN_PRESENT = 'mp';

/** Через сколько без обеих сторон звать организатора. */
export const NO_SHOW_AFTER_MS = 10 * 60 * 1_000;

interface Side {
  name: string;
  members: string[];
  voiceChannelId: string | null;
  present: boolean;
}

export interface MatchCard {
  matchId: number;
  a: Side;
  b: Side;
  draftUrl: string | null;
  live: boolean;
  /** Прошлые встречи этих соперников на сервере. `null` — не встречались. */
  history: { games: number; winsA: number; winsB: number; byCaptains: boolean } | null;
}

/** Соперничество — от трёх встреч, где счёт почти равный: такие пары и ждут. */
export function isRivalry(history: { games: number; winsA: number; winsB: number }): boolean {
  return history.games >= 3 && Math.abs(history.winsA - history.winsB) <= 1;
}

export function matchCardText(card: MatchCard): string {
  const mention = (side: Side): string =>
    side.members.length > 0 ? side.members.map((id) => `<@${id}>`).join(' ') : `**${side.name}**`;
  const mark = (side: Side): string => (side.present ? '✅' : '⏳');
  const voices = [card.a.voiceChannelId, card.b.voiceChannelId].filter((id): id is string => id !== null);

  return [
    `## Матч №${card.matchId} · ${card.a.name} — ${card.b.name}`,
    `${mention(card.a)}`,
    'против',
    `${mention(card.b)}`,
    '',
    ...(voices.length > 0 ? [`Голосовые: ${voices.map((id) => `<#${id}>`).join(' · ')}`] : []),
    ...(card.draftUrl ? [`Драфт: ${card.draftUrl} — ссылки на ходы ушли капитанам в личку.`] : []),
    ...(card.history
      ? [
          `${isRivalry(card.history) ? '🔥 Соперничество · ' : ''}Личные встречи${card.history.byCaptains ? ' капитанов' : ''}: ${card.a.name} **${card.history.winsA}** — **${card.history.winsB}** ${card.b.name}`,
        ]
      : []),
    '',
    `${mark(card.a)} ${card.a.name} · ${mark(card.b)} ${card.b.name}`,
    card.live
      ? '**Матч начался.** Победитель пишет `/match report`.'
      : `Команда в сборе — жмите **На месте**. Когда на месте обе стороны, матч начинается${card.draftUrl ? ' и идёт таймер драфта' : ''}. Через ${NO_SHOW_AFTER_MS / 60_000} минут без одной из сторон бот позовёт организатора.`,
  ].join('\n');
}

export function matchCardButtons(card: MatchCard): ActionRowBuilder<ButtonBuilder>[] {
  if (card.live) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${BTN_PRESENT}:${card.matchId}`).setLabel('На месте').setStyle(ButtonStyle.Success),
    ),
  ];
}

/** Всё для карточки из базы: имена, составы, голосовые, драфт, кто уже на месте. */
export async function buildMatchCard(deps: PlayDeps, match: MatchRow): Promise<MatchCard> {
  const view = await deps.tournaments.bracket(match.tournamentId);
  const sideOf = async (entrantId: number | null, present: boolean): Promise<Side> => {
    const entrant = view.entrants.find((row) => row.id === entrantId);
    return {
      name: entrant?.displayName ?? '?',
      members: entrantId === null ? [] : await deps.tournaments.membersOf(entrantId),
      voiceChannelId: entrant?.voiceChannelId ?? null,
      present,
    };
  };
  const draft = deps.drafts ? await deps.drafts.byMatch(match.id) : null;

  const captainA = view.entrants.find((row) => row.id === match.entrantAId)?.captainUserId;
  const captainB = view.entrants.find((row) => row.id === match.entrantBId)?.captainUserId;
  const past =
    captainA && captainB
      ? await deps.tournaments.headToHead(view.tournament.guildId, captainA, captainB, match.id, view.tournament.entryMode).catch(() => null)
      : null;

  return {
    matchId: match.id,
    a: await sideOf(match.entrantAId, match.presentAAt !== null),
    b: await sideOf(match.entrantBId, match.presentBAt !== null),
    draftUrl: draft ? `${deps.publicBaseUrl}/draft/${match.id}` : null,
    live: match.liveAt !== null,
    history: past && past.games > 0 ? { ...past, byCaptains: view.tournament.entryMode === 'team' } : null,
  };
}

/**
 * Выложить карточки матчам, которые стали играбельными. Шаг синхронизатора: идёт после веток
 * и драфтов, чтобы в карточке была ссылка на драфт.
 *
 * Карточку не выложить нельзя без последствий: без неё некому нажать «На месте», и драфт
 * ждал бы вечно. Поэтому если ветки нет вовсе (у турнира не задан канал для веток) или
 * отправка отказала — матч начинается сразу, как было до карточек.
 */
export async function postMatchCards(deps: PlayDeps, guild: Guild, tournamentId: number, logger: Logger): Promise<void> {
  const tournament = await deps.tournaments.byId(tournamentId);

  if (!tournament.matchParentId) {
    for (const match of await deps.tournaments.matchesWaitingToStart(tournamentId)) {
      await deps.tournaments.startMatch(match.id);
    }
    return;
  }

  // Канал для веток задан, а ветку создать не вышло (нет права, канал удалён): карточку
  // выложить некуда, и без неё матч ждал бы «На месте» вечно, никому ничего не сказав.
  // Начинаем такие матчи сразу, а организатора зовём один раз за турнир — чинить права.
  const threadless = (await deps.tournaments.matchesWaitingToStart(tournamentId)).filter((match) => match.threadId === null);
  for (const match of threadless) await deps.tournaments.startMatch(match.id);
  if (threadless.length > 0 && deps.staff) {
    await staffAlert(deps.staff, guild, {
      tournament,
      text: `⚠️ Турнир «${tournament.name}»: ветки матчей не создаются в <#${tournament.matchParentId}> — у бота нет права «Создавать приватные ветки» или канал недоступен. Матчи начинаются без карточки «На месте».`,
      dedupeKey: `threads:${tournamentId}`,
      dedupeMs: 6 * 60 * 60 * 1_000,
    }).catch((error: unknown) => logger.warn({ err: error, tournamentId }, 'сигнал о ветках не отправился'));
  }

  for (const match of await deps.tournaments.matchesNeedingCard(tournamentId)) {
    if (!(await deps.tournaments.markAnnounced(match.id))) continue;
    const card = await buildMatchCard(deps, match);

    const thread = match.threadId ? await guild.channels.fetch(match.threadId).catch(() => null) : null;
    const sent = thread?.isSendable()
      ? await thread
          .send({
            content: matchCardText(card),
            components: matchCardButtons(card),
            allowedMentions: { users: [...card.a.members, ...card.b.members] },
          })
          .catch((error: unknown) => {
            logger.warn({ err: error, matchId: match.id }, 'карточка матча не отправилась');
            return null;
          })
      : null;

    if (sent) await deps.tournaments.attachCard(match.id, sent.id);
    else await deps.tournaments.startMatch(match.id);
  }
}

/**
 * Перерисовать карточку по состоянию матча — когда он начался не из неё: со страницы драфта
 * или решением организатора. Иначе в ветке висело бы «жмите На месте» у идущего матча.
 */
export async function refreshMatchCard(deps: PlayDeps, guild: Guild, matchId: number): Promise<void> {
  const match = await deps.tournaments.matchById(matchId);
  if (!match.threadId || !match.cardMessageId) return;
  const thread = await guild.channels.fetch(match.threadId).catch(() => null);
  if (!thread?.isTextBased()) return;
  const message = await thread.messages.fetch(match.cardMessageId).catch(() => null);
  if (!message) return;
  const card = await buildMatchCard(deps, match);
  await message.edit({ content: matchCardText(card), components: matchCardButtons(card), allowedMentions: { parse: [] } });
}
