import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type Client,
  type Guild,
  type Interaction,
} from 'discord.js';
import { describeForUser } from '../../core/errors.js';
import type { EventBus } from '../../core/events/bus.js';
import type { Logger } from '../../core/logger.js';
import type { EventHandler } from '../../core/module.js';
import type { TournamentsService } from '../tournaments/services/tournaments.js';
import { BASE_REWARD, MAX_MULTIPLIER } from './payout.js';
import type { PredictionsService } from './service.js';

/**
 * Прогнозы кнопками — в публичной ветке «Прогнозы» под каналом объявлений.
 *
 * Раньше прогноз давался командой `/predict match` по номеру матча, который надо было найти на
 * сайте. Смотреть чужой матч без ставки в нём скучно — но и ставить так было неудобно, и
 * прогнозов почти не было. Теперь на каждый матч, ставший играбельным, в ветке появляется
 * карточка: две кнопки и живой расклад голосов. Приём закрывается, когда матч начался (обе
 * стороны нажали «На месте»): видя пики, угадывать уже нечестно.
 *
 * Ветки матчей закрытые — зрители их не видят, — поэтому ветка прогнозов своя, одна на турнир.
 *
 * Слушатели шины не ждут Discord: событие публикуется посреди нажатия кнопки подтверждения, и
 * отправка карточки там съела бы окно в три секунды, отведённое на ответ. Работа уходит в фон,
 * а её отказы — в лог; карточка, которая не отправилась, не мешает ни матчу, ни прогнозам
 * командой.
 */

const BTN_VOTE = 'pv';

/** Перерисовка карточки не чаще раза в три секунды: на всплеск голосов — одна правка. */
const REFRESH_DEBOUNCE_MS = 3_000;

export interface CardView {
  matchId: number;
  a: { id: number; name: string; votes: number };
  b: { id: number; name: string; votes: number };
  locked: boolean;
  winnerId: number | null;
}

function bar(votes: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round((votes / total) * 5);
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}

export function predictionCardText(view: CardView): string {
  const total = view.a.votes + view.b.votes;
  const lines = [
    `**Матч №${view.matchId}** · ${view.a.name} — ${view.b.name}`,
    `${view.a.name} ${bar(view.a.votes, total)} ${view.a.votes} · ${view.b.name} ${bar(view.b.votes, total)} ${view.b.votes}`,
  ];
  if (view.winnerId !== null) {
    const winner = view.winnerId === view.a.id ? view.a : view.b;
    lines.push(`Победа **${winner.name}**. Угадали ${winner.votes} из ${total}.`);
  } else if (view.locked) {
    lines.push('Приём закрыт — матч идёт.');
  } else {
    lines.push(
      `Кто победит? Угадавший получает монеты: ${BASE_REWARD} и больше — чем меньше угадавших, тем больше каждому, до ${MAX_MULTIPLIER} раз. Приём закроется, когда матч начнётся.`,
    );
  }
  return lines.join('\n');
}

export function predictionCardButtons(view: CardView): ActionRowBuilder<ButtonBuilder>[] {
  if (view.locked || view.winnerId !== null) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BTN_VOTE}:${view.matchId}:${view.a.id}`)
        .setLabel(`За ${view.a.name}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${BTN_VOTE}:${view.matchId}:${view.b.id}`)
        .setLabel(`За ${view.b.name}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

export interface BoardDeps {
  predictions: PredictionsService;
  tournaments: Pick<TournamentsService, 'byId' | 'matchById' | 'bracket'>;
  logger: Logger;
}

export function createPredictionsBoard(deps: BoardDeps) {
  const { predictions, tournaments, logger } = deps;
  const timers = new Map<number, NodeJS.Timeout>();
  /**
   * Создание ветки — по одному на турнир. На старте событие «матч готов» приходит на каждый
   * матч первого круга разом, и каждое завело бы свою ветку: лишние удалились бы, но сообщения
   * «начата ветка» остались бы в канале объявлений.
   */
  const boards = new Map<number, Promise<string | null>>();

  /** Работа в фон: слушатель шины возвращается сразу, отказ — в лог. */
  const background = (what: string, work: () => Promise<unknown>): void => {
    void work().catch((error: unknown) => logger.warn({ err: error }, what));
  };

  async function view(matchId: number): Promise<CardView | null> {
    const match = await tournaments.matchById(matchId);
    if (match.entrantAId === null || match.entrantBId === null) return null;
    const bracket = await tournaments.bracket(match.tournamentId);
    const nameOf = (id: number): string => bracket.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';
    const votes = await predictions.tally(matchId);
    const votesOf = (id: number): number => votes.find((row) => row.entrantId === id)?.votes ?? 0;
    const card = await predictions.cardOf(matchId);
    return {
      matchId,
      a: { id: match.entrantAId, name: nameOf(match.entrantAId), votes: votesOf(match.entrantAId) },
      b: { id: match.entrantBId, name: nameOf(match.entrantBId), votes: votesOf(match.entrantBId) },
      // Закрыта и тогда, когда матч начался раньше, чем карточка успела выйти: иначе она вышла
      // бы с кнопками, на которые уже нельзя ответить.
      locked: (card?.lockedAt !== null && card?.lockedAt !== undefined) || match.liveAt !== null,
      winnerId: match.winnerEntrantId,
    };
  }

  /** Ветка прогнозов турнира — существующая или новая. `null` — завести негде. */
  function ensureBoard(guild: Guild, tournamentId: number): Promise<string | null> {
    const running = boards.get(tournamentId);
    if (running) return running;
    const work = createBoard(guild, tournamentId).finally(() => boards.delete(tournamentId));
    boards.set(tournamentId, work);
    return work;
  }

  async function createBoard(guild: Guild, tournamentId: number): Promise<string | null> {
    const existing = await predictions.boardOf(tournamentId);
    if (existing) return existing.threadId;

    const tournament = await tournaments.byId(tournamentId);
    if (!tournament.announceChannelId) return null;
    const channel = await guild.channels.fetch(tournament.announceChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return null;

    const thread = await channel.threads.create({
      name: `Прогнозы · ${tournament.name}`.slice(0, 100),
      type: ChannelType.PublicThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Прогнозы на матчи турнира',
    });
    if (!(await predictions.saveBoard(tournamentId, thread.id))) {
      // Ветку успел завести другой путь — наша лишняя.
      await thread.delete().catch(() => undefined);
      return (await predictions.boardOf(tournamentId))?.threadId ?? null;
    }
    await thread.send(
      [
        `## Прогнозы · ${tournament.name}`,
        'На каждый матч здесь будет карточка с двумя кнопками. Прогноз бесплатный, поменять его нельзя, а игроки матча не голосуют за свой матч.',
        'Приём закрывается, когда матч начался. Лучшие прогнозисты сервера — `/predict board`.',
      ].join('\n'),
    );
    return thread.id;
  }

  async function postCard(client: Client, matchId: number): Promise<void> {
    if (await predictions.cardOf(matchId)) return;
    const match = await tournaments.matchById(matchId);
    const tournament = await tournaments.byId(match.tournamentId);
    const guild = client.guilds.cache.get(tournament.guildId);
    if (!guild) return;
    const threadId = await ensureBoard(guild, tournament.id);
    if (!threadId) return;
    const thread = await guild.channels.fetch(threadId).catch(() => null);
    if (!thread?.isSendable()) return;

    const card = await view(matchId);
    if (!card) return;
    const message = await thread.send({ content: predictionCardText(card), components: predictionCardButtons(card) });
    if (!(await predictions.saveCard(matchId, thread.id, message.id))) await message.delete().catch(() => undefined);
  }

  async function refreshNow(client: Client, matchId: number): Promise<void> {
    const stored = await predictions.cardOf(matchId);
    if (!stored) return;
    const card = await view(matchId);
    if (!card) return;
    const channel = await client.channels.fetch(stored.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(stored.messageId).catch(() => null);
    await message?.edit({ content: predictionCardText(card), components: predictionCardButtons(card) });
  }

  /** Перерисовать не сразу: всплеск голосов даёт одну правку, а не десять. */
  function refreshSoon(client: Client, matchId: number): void {
    if (timers.has(matchId)) return;
    const timer = setTimeout(() => {
      timers.delete(matchId);
      background('карточка прогноза не перерисовалась', () => refreshNow(client, matchId));
    }, REFRESH_DEBOUNCE_MS);
    timer.unref();
    timers.set(matchId, timer);
  }

  async function archiveBoard(client: Client, tournamentId: number, text: string): Promise<void> {
    const board = await predictions.boardOf(tournamentId);
    if (!board) return;
    const thread = await client.channels.fetch(board.threadId).catch(() => null);
    if (!thread?.isThread()) return;
    await thread.send(text).catch(() => undefined);
    await thread.setArchived(true, 'Турнир закрыт').catch(() => undefined);
  }

  return {
    /** Подписка на ход турнира. Всё — в фон: событие публикуется посреди чужого нажатия. */
    listen(bus: EventBus, client: Client): void {
      bus.on('tournament.started', async ({ guildId, tournamentId }) => {
        background('ветка прогнозов не завелась', async () => {
          const guild = client.guilds.cache.get(guildId);
          if (guild) await ensureBoard(guild, tournamentId);
        });
      });
      bus.on('match.ready', async ({ matchId }) => {
        background('карточка прогноза не отправилась', () => postCard(client, matchId));
      });
      bus.on('match.live', async ({ matchId }) => {
        background('приём прогнозов не закрылся на карточке', async () => {
          if (await predictions.lockCard(matchId)) await refreshNow(client, matchId);
        });
      });
      bus.on('match.confirmed', async ({ matchId, via }) => {
        if (via === 'bye') return;
        background('итог на карточке прогноза не показан', async () => {
          await predictions.lockCard(matchId);
          await refreshNow(client, matchId);
        });
      });
      // Матч пересобирается с другой парой: прогнозы и карточку прежней пары — сбросить сразу,
      // не в фоне. Следом придёт «матч готов», и новая карточка выйдет, только если старой в
      // базе уже нет. Сообщение прежней карточки удаляется в фоне — это только Discord.
      bus.on('match.reset', async ({ matchId }) => {
        const stale = await predictions.resetMatch(matchId).catch((error: unknown) => {
          logger.warn({ err: error, matchId }, 'прогнозы пересобираемого матча не сброшены');
          return null;
        });
        if (!stale) return;
        background('старая карточка прогноза не удалилась', async () => {
          const channel = await client.channels.fetch(stale.channelId).catch(() => null);
          if (!channel?.isTextBased()) return;
          const message = await channel.messages.fetch(stale.messageId).catch(() => null);
          await message?.delete();
        });
      });
      bus.on('match.corrected', async ({ matchId, winnerEntrantId }) => {
        background('прогнозы после исправления не пересчитались', async () => {
          await predictions.resettle(matchId, winnerEntrantId);
          await refreshNow(client, matchId);
        });
      });
      bus.on('tournament.cancelled', async ({ tournamentId }) => {
        background('прогнозы отменённого турнира не аннулированы', async () => {
          const voided = await predictions.voidTournament(tournamentId);
          await archiveBoard(
            client,
            tournamentId,
            `Турнир отменён — прогнозы аннулированы${voided > 0 ? ` (${voided})` : ''}, монеты по ним не начисляются.`,
          );
        });
      });
      bus.on('tournament.finished', async ({ tournamentId }) => {
        background('ветка прогнозов не закрылась', () =>
          archiveBoard(client, tournamentId, 'Турнир завершён. Монеты за угаданные исходы начисляются в течение нескольких минут. Лучшие — `/predict board`.'),
        );
      });
    },

    /** Кнопки «За A» / «За B». */
    buttons(): EventHandler<'interactionCreate'> {
      return {
        event: 'interactionCreate',
        async handle(ctx, interaction: Interaction): Promise<void> {
          if (!interaction.isButton()) return;
          const [prefix, rawMatch, rawEntrant] = interaction.customId.split(':');
          if (prefix !== BTN_VOTE) return;
          const matchId = Number.parseInt(rawMatch ?? '', 10);
          const entrantId = Number.parseInt(rawEntrant ?? '', 10);
          if (!Number.isInteger(matchId) || !Number.isInteger(entrantId) || !interaction.guildId) return;

          try {
            await predictions.predict(matchId, interaction.guildId, interaction.user.id, entrantId);
            const card = await view(matchId);
            const pick = card ? (card.a.id === entrantId ? card.a.name : card.b.name) : '?';
            await interaction.reply({
              content: `Прогноз принят: победит **${pick}**. Поменять нельзя — иначе можно было бы передумать, увидев игру.`,
              flags: MessageFlags.Ephemeral,
            });
            refreshSoon(ctx.client, matchId);
          } catch (error) {
            const described = describeForUser(error);
            if (described.incidentId) ctx.logger.error({ err: error, incidentId: described.incidentId }, 'прогноз кнопкой упал');
            await interaction.reply({ content: described.text, flags: MessageFlags.Ephemeral }).catch(() => undefined);
          }
        },
      };
    },
  };
}
