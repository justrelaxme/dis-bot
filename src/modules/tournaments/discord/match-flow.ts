import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Interaction,
} from 'discord.js';
import { UserError, describeForUser } from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import type { EventHandler } from '../../../core/module.js';
import type { PlayDeps } from '../commands/play.js';
import { AUTO_CONFIRM_AFTER_MS } from '../services/tournaments.js';
import type { MatchRow } from '../schema.js';
import { BTN_PRESENT, NO_SHOW_AFTER_MS, buildMatchCard, matchCardButtons, matchCardText } from './match-card.js';
import { isOrganizer, staffAlert } from './staff.js';
import { syncTournament } from './sync.js';

/**
 * Ход матча между «стал играбельным» и «закрыт»: присутствие, неявка, напоминание о
 * подтверждении. То, что раньше держалось на организаторе, который смотрит во все ветки сразу.
 */

/** Кнопки организатора при неявке: техпобеда стороне, подождать, начать без отметки. */
const BTN_NO_SHOW_WALKOVER = 'nw';
const BTN_NO_SHOW_WAIT = 'nz';
const BTN_NO_SHOW_START = 'nl';

/** Сколько даёт «Подождать». */
export const NO_SHOW_WAIT_MS = 5 * 60 * 1_000;

/** За сколько до автоподтверждения напоминать сопернику. */
export const CONFIRM_REMINDER_LEAD_MS = 15 * 60 * 1_000;

const PREFIXES = [BTN_PRESENT, BTN_NO_SHOW_WALKOVER, BTN_NO_SHOW_WAIT, BTN_NO_SHOW_START];

export function createMatchFlowHandler(deps: PlayDeps): EventHandler<'interactionCreate'> {
  return {
    event: 'interactionCreate',
    async handle(ctx, interaction: Interaction): Promise<void> {
      if (!interaction.isButton()) return;
      const [prefix, rawMatch, rawEntrant] = interaction.customId.split(':');
      if (!prefix || !PREFIXES.includes(prefix)) return;
      const matchId = Number.parseInt(rawMatch ?? '', 10);
      if (!Number.isInteger(matchId)) return;

      try {
        if (prefix === BTN_PRESENT) {
          await present(deps, interaction, matchId);
          return;
        }
        await organizerDecision(deps, interaction, prefix, matchId, Number.parseInt(rawEntrant ?? '', 10), ctx.logger);
      } catch (error) {
        const described = describeForUser(error);
        if (described.incidentId) {
          ctx.logger.error({ err: error, incidentId: described.incidentId }, 'кнопка хода матча упала');
        }
        const payload = { content: described.text, flags: MessageFlags.Ephemeral } as const;
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    },
  };
}

/** «На месте»: карточка перерисовывается на месте — кто отметился, видно всем в ветке. */
async function present(deps: PlayDeps, interaction: ButtonInteraction, matchId: number): Promise<void> {
  const result = await deps.tournaments.markPresent(matchId, interaction.user.id);
  const card = await buildMatchCard(deps, result.match);
  await interaction.update({
    content: matchCardText(card),
    components: matchCardButtons(card),
    // Перерисовка не должна звать всех второй раз.
    allowedMentions: { parse: [] },
  });
  if (result.alreadyPresent) {
    await interaction.followUp({ content: 'Твоя сторона уже отмечена.', flags: MessageFlags.Ephemeral });
  }
}

async function organizerDecision(
  deps: PlayDeps,
  interaction: ButtonInteraction,
  prefix: string,
  matchId: number,
  entrantId: number,
  logger: Logger,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new UserError('Это работает только на сервере.');
  const settings = (await deps.staff?.settings.get(guild.id).catch(() => null)) ?? null;
  if (!isOrganizer(interaction.member, settings)) throw new UserError('Решать это может только организатор.');

  const match = await deps.tournaments.matchById(matchId);
  const by = `<@${interaction.user.id}>`;
  let decision: string;

  if (prefix === BTN_NO_SHOW_WALKOVER) {
    if (!Number.isInteger(entrantId)) return;
    await deps.tournaments.walkover(matchId, interaction.user.id, entrantId);
    const view = await deps.tournaments.bracket(match.tournamentId);
    decision = `Техпобеда **${view.entrants.find((entrant) => entrant.id === entrantId)?.displayName ?? '?'}** — решил ${by}.`;
  } else if (prefix === BTN_NO_SHOW_WAIT) {
    await deps.tournaments.snoozeNoShow(matchId, NO_SHOW_WAIT_MS, NO_SHOW_AFTER_MS);
    decision = `Ждём ещё ${NO_SHOW_WAIT_MS / 60_000} минут — решил ${by}. Не придут — позову снова.`;
  } else {
    await deps.tournaments.startMatch(matchId);
    decision = `Матч начат без отметки — решил ${by}.`;
  }

  await interaction.update({
    content: `${interaction.message.content}\n\n**${decision}**`,
    components: [],
    allowedMentions: { parse: [] },
  });
  await syncTournament(deps, guild, match.tournamentId, logger);
}

/** Кнопки для сигнала о неявке. */
function noShowButtons(match: MatchRow, names: { a: string; b: string }): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (match.entrantAId !== null) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${BTN_NO_SHOW_WALKOVER}:${match.id}:${match.entrantAId}`)
        .setLabel(`Техпобеда: ${names.a}`.slice(0, 80))
        .setStyle(ButtonStyle.Danger),
    );
  }
  if (match.entrantBId !== null) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${BTN_NO_SHOW_WALKOVER}:${match.id}:${match.entrantBId}`)
        .setLabel(`Техпобеда: ${names.b}`.slice(0, 80))
        .setStyle(ButtonStyle.Danger),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`${BTN_NO_SHOW_WAIT}:${match.id}`)
      .setLabel(`Подождать ${NO_SHOW_WAIT_MS / 60_000} мин`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${BTN_NO_SHOW_START}:${match.id}`).setLabel('Начать без отметки').setStyle(ButtonStyle.Primary),
  );
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

/**
 * Один проход джобы: неявки — в штаб, напоминания — сопернику. Каждое событие один раз:
 * отметки ставятся CAS-ом до отправки.
 */
export async function runMatchFlow(deps: PlayDeps, client: Client, logger: Logger, now: Date): Promise<void> {
  if (deps.staff) {
    for (const match of await deps.tournaments.noShowsDue(now, NO_SHOW_AFTER_MS)) {
      try {
        if (!(await deps.tournaments.markEscalated(match.id, now))) continue;
        const tournament = await deps.tournaments.byId(match.tournamentId);
        const guild = client.guilds.cache.get(tournament.guildId);
        if (!guild) continue;
        const view = await deps.tournaments.bracket(match.tournamentId);
        const nameOf = (id: number | null): string => view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';
        const mark = (at: Date | null): string => (at ? '✅ на месте' : '⏳ нет');

        await staffAlert(deps.staff, guild, {
          tournament,
          text: [
            `⏰ **Неявка в матче №${match.id}** «${tournament.name}»: карточка висит ${NO_SHOW_AFTER_MS / 60_000} минут.`,
            `${nameOf(match.entrantAId)} — ${mark(match.presentAAt)} · ${nameOf(match.entrantBId)} — ${mark(match.presentBAt)}${match.threadId ? ` · ветка <#${match.threadId}>` : ''}`,
          ].join('\n'),
          components: noShowButtons(match, { a: nameOf(match.entrantAId), b: nameOf(match.entrantBId) }),
        });
      } catch (error) {
        logger.error({ err: error, matchId: match.id }, 'сигнал о неявке не отправлен');
      }
    }
  }

  for (const match of await deps.tournaments.confirmRemindersDue(now, AUTO_CONFIRM_AFTER_MS - CONFIRM_REMINDER_LEAD_MS)) {
    try {
      if (!match.threadId || match.reportedBy === null) continue;
      if (!(await deps.tournaments.markConfirmReminded(match.id))) continue;
      const tournament = await deps.tournaments.byId(match.tournamentId);
      const guild = client.guilds.cache.get(tournament.guildId);
      const thread = guild ? await guild.channels.fetch(match.threadId).catch(() => null) : null;
      if (!thread?.isSendable()) continue;

      const reporter = await deps.tournaments.entrantOfUser(match.tournamentId, match.reportedBy);
      const opponentId = reporter?.id === match.entrantAId ? match.entrantBId : match.entrantAId;
      const opponents = opponentId === null ? [] : await deps.tournaments.membersOf(opponentId);
      await thread.send({
        content: `${opponents.map((id) => `<@${id}>`).join(' ')} — результат матча №${match.id} заявлен, через ${CONFIRM_REMINDER_LEAD_MS / 60_000} минут он примется сам. Не согласны — «Оспорить» под заявкой.`,
        allowedMentions: { users: opponents },
      });
    } catch (error) {
      logger.error({ err: error, matchId: match.id }, 'напоминание о подтверждении не отправлено');
    }
  }
}
