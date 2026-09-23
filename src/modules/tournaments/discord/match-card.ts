import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import type { PlayDeps } from '../commands/play.js';
import type { MatchRow } from '../schema.js';

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

  return {
    matchId: match.id,
    a: await sideOf(match.entrantAId, match.presentAAt !== null),
    b: await sideOf(match.entrantBId, match.presentBAt !== null),
    draftUrl: draft ? `${deps.publicBaseUrl}/draft/${match.id}` : null,
    live: match.liveAt !== null,
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

  for (const match of await deps.tournaments.matchesNeedingCard(tournamentId)) {
    if (!(await deps.tournaments.markAnnounced(match.id))) continue;
    const card = await buildMatchCard(deps, match);

    const thread = match.threadId ? await guild.channels.fetch(match.threadId).catch(() => null) : null;
    const sent =
      thread?.isSendable() &&
      (await thread
        .send({
          content: matchCardText(card),
          components: matchCardButtons(card),
          allowedMentions: { users: [...card.a.members, ...card.b.members] },
        })
        .then(() => true)
        .catch((error: unknown) => {
          logger.warn({ err: error, matchId: match.id }, 'карточка матча не отправилась');
          return false;
        }));

    if (!sent) await deps.tournaments.startMatch(match.id);
  }
}
