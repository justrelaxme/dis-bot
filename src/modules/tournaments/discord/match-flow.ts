import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
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

/** «Оспорить» под заявкой результата и окно с причиной. */
const BTN_DISPUTE = 'md';
const MODAL_DISPUTE = 'mdm';
const FIELD_REASON = 'reason';

/** Решения организатора по спору: принять заявленное, отдать сопернику, переиграть. */
const BTN_DISPUTE_ACCEPT = 'da';
const BTN_DISPUTE_GIVE = 'dg';
const BTN_DISPUTE_REPLAY = 'dr';

const PREFIXES = [
  BTN_PRESENT,
  BTN_NO_SHOW_WALKOVER,
  BTN_NO_SHOW_WAIT,
  BTN_NO_SHOW_START,
  BTN_DISPUTE,
  BTN_DISPUTE_ACCEPT,
  BTN_DISPUTE_GIVE,
  BTN_DISPUTE_REPLAY,
];

export function createMatchFlowHandler(deps: PlayDeps): EventHandler<'interactionCreate'> {
  return {
    event: 'interactionCreate',
    async handle(ctx, interaction: Interaction): Promise<void> {
      if (!interaction.isButton() && !interaction.isModalSubmit()) return;
      const [prefix, rawMatch, rawEntrant] = interaction.customId.split(':');
      const known = interaction.isModalSubmit() ? prefix === MODAL_DISPUTE : !!prefix && PREFIXES.includes(prefix);
      if (!known) return;
      const matchId = Number.parseInt(rawMatch ?? '', 10);
      if (!Number.isInteger(matchId)) return;

      try {
        if (interaction.isModalSubmit()) {
          await disputeSubmitted(deps, interaction, matchId, ctx.logger);
          return;
        }
        if (prefix === BTN_PRESENT) {
          await present(deps, interaction, matchId);
          return;
        }
        if (prefix === BTN_DISPUTE) {
          // Окно нельзя показать после defer — отвечаем им сразу. Проверку, что оспаривает
          // участник, делает сервис при отправке: окно само по себе ничего не меняет.
          await interaction.showModal(disputeModal(matchId));
          return;
        }
        if (prefix === BTN_DISPUTE_ACCEPT || prefix === BTN_DISPUTE_GIVE || prefix === BTN_DISPUTE_REPLAY) {
          await disputeDecision(deps, interaction, prefix, matchId, ctx.logger);
          return;
        }
        await organizerDecision(deps, interaction, prefix ?? '', matchId, Number.parseInt(rawEntrant ?? '', 10), ctx.logger);
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
  const guild = await requireOrganizer(deps, interaction);
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

function disputeModal(matchId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${MODAL_DISPUTE}:${matchId}`)
    .setTitle(`Спор по матчу №${matchId}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REASON)
          .setLabel('Что не так с заявленным результатом')
          .setPlaceholder('Например: победили мы, счёт 13:9 — скриншот приложу в ветку')
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(5)
          .setMaxLength(500)
          .setRequired(true),
      ),
    );
}

/** Организатор — только «Управление сервером» или роль организаторов. */
async function requireOrganizer(deps: PlayDeps, interaction: ButtonInteraction): Promise<Guild> {
  const guild = interaction.guild;
  if (!guild) throw new UserError('Это работает только на сервере.');
  const settings = (await deps.staff?.settings.get(guild.id).catch(() => null)) ?? null;
  if (!isOrganizer(interaction.member, settings)) throw new UserError('Решать это может только организатор.');
  return guild;
}

/**
 * Спор отправлен. Причина уходит и в ветку — соперник видит, с чем не согласны, — и в штаб, с
 * кнопками решения. Скриншот просим приложить в ветку: окно Discord файлов не принимает.
 */
async function disputeSubmitted(
  deps: PlayDeps,
  interaction: ModalSubmitInteraction,
  matchId: number,
  logger: Logger,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new UserError('Это работает только на сервере.');
  const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
  const match = await deps.tournaments.dispute(matchId, interaction.user.id, reason);

  // Кнопки под заявкой больше не нужны: подтверждать нечего, решает организатор.
  if (interaction.isFromMessage()) await interaction.update({ components: [] });
  const text = [
    `**Матч №${match.id} оспорен** <@${interaction.user.id}>: ${reason}`,
    'Приложите скриншот итога сюда, в ветку. Организатора уже позвал — он решит.',
  ].join('\n');
  if (interaction.deferred || interaction.replied) await interaction.followUp({ content: text, allowedMentions: { parse: [] } });
  else await interaction.reply({ content: text, allowedMentions: { parse: [] } });

  if (!deps.staff) return;
  const tournament = await deps.tournaments.byId(match.tournamentId);
  const view = await deps.tournaments.bracket(match.tournamentId);
  const nameOf = (id: number | null): string => view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';
  const other = match.reportedWinnerId === match.entrantAId ? match.entrantBId : match.entrantAId;

  await staffAlert(deps.staff, guild, {
    tournament,
    text: [
      `⚖️ **Спор в матче №${match.id}** «${tournament.name}»: ${nameOf(match.entrantAId)} — ${nameOf(match.entrantBId)}.`,
      `Заявлена победа **${nameOf(match.reportedWinnerId)}**, оспорил <@${interaction.user.id}>: «${reason}».${match.threadId ? ` Ветка: <#${match.threadId}>.` : ''}`,
    ].join('\n'),
    dedupeKey: `dispute:${match.id}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${BTN_DISPUTE_ACCEPT}:${match.id}`)
          .setLabel(`Принять: ${nameOf(match.reportedWinnerId)}`.slice(0, 80))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${BTN_DISPUTE_GIVE}:${match.id}`)
          .setLabel(`Отдать: ${nameOf(other)}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${BTN_DISPUTE_REPLAY}:${match.id}`).setLabel('Переиграть').setStyle(ButtonStyle.Secondary),
      ),
    ],
  }).catch((error: unknown) => logger.error({ err: error, matchId }, 'спор не дошёл до штаба'));
}

/**
 * Решение по спору одной кнопкой. Организатор, нажавший её, попадает в ветку матча: разговор
 * о решении идёт там, где спорили, а не в штабе.
 */
async function disputeDecision(
  deps: PlayDeps,
  interaction: ButtonInteraction,
  prefix: string,
  matchId: number,
  logger: Logger,
): Promise<void> {
  const guild = await requireOrganizer(deps, interaction);
  const match = await deps.tournaments.matchById(matchId);
  if (match.state !== 'disputed') throw new UserError('Этот спор уже решён.');
  const view = await deps.tournaments.bracket(match.tournamentId);
  const nameOf = (id: number | null): string => view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';
  const by = `<@${interaction.user.id}>`;

  let decision: string;
  if (prefix === BTN_DISPUTE_REPLAY) {
    await deps.tournaments.replay(matchId, interaction.user.id);
    decision = `Матч переигрывается — решил ${by}.`;
  } else {
    const winner =
      prefix === BTN_DISPUTE_ACCEPT
        ? match.reportedWinnerId
        : match.reportedWinnerId === match.entrantAId
          ? match.entrantBId
          : match.entrantAId;
    if (winner === null) throw new UserError('У матча не известен соперник.');
    await deps.tournaments.resolve(matchId, interaction.user.id, winner);
    decision = `Победа **${nameOf(winner)}** — решил ${by}.`;
  }

  await interaction.update({
    content: `${interaction.message.content}\n\n**${decision}**`,
    components: [],
    allowedMentions: { parse: [] },
  });

  if (match.threadId) {
    await deps.channels.setThreadMember({ guild, threadId: match.threadId, userId: interaction.user.id, present: true });
    const thread = await guild.channels.fetch(match.threadId).catch(() => null);
    if (thread?.isSendable()) {
      const replayed = prefix === BTN_DISPUTE_REPLAY ? await buildMatchCard(deps, await deps.tournaments.matchById(matchId)) : null;
      await thread
        .send({
          content: replayed
            ? `**Спор решён: переигровка** (${by}).\n\n${matchCardText(replayed)}`
            : `**Спор решён:** ${decision}`,
          ...(replayed ? { components: matchCardButtons(replayed) } : {}),
          allowedMentions: replayed ? { users: [...replayed.a.members, ...replayed.b.members] } : { parse: [] },
        })
        .catch((error: unknown) => logger.warn({ err: error, matchId }, 'решение по спору не ушло в ветку'));
    }
  }

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
        content: `${opponents.map((id) => `<@${id}>`).join(' ')} — результат матча №${match.id} заявлен, через ${CONFIRM_REMINDER_LEAD_MS / 60_000} минут он примется сам. Не согласны — кнопка «Не так было» под заявкой.`,
        allowedMentions: { users: opponents },
      });
    } catch (error) {
      logger.error({ err: error, matchId: match.id }, 'напоминание о подтверждении не отправлено');
    }
  }
}
