import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import type { EntrantRow, TournamentRow } from '../schema.js';

/**
 * Проводник для новичка.
 *
 * Объявления с инструкцией «капитан пишет /team create, остальные жмут кнопку» достаточно
 * тому, кто уже понимает устройство турнира. Новичок на нём застревает: он не знает, быть
 * ему капитаном или искать команду, привязан ли у него аккаунт, есть ли вообще куда
 * вступать, и когда отмечаться. Поэтому вместо инструкции — панель с кнопками и одна
 * кнопка «что мне делать», которая смотрит на **состояние именно этого человека** и
 * называет следующий шаг. Общая инструкция отвечает всем одинаково; проводник — каждому по
 * его положению.
 */

export const BTN_PANEL_CREATE = 'pc';
export const BTN_PANEL_FIND = 'pf';
export const BTN_PANEL_HELP = 'ph';
export const BTN_PANEL_SOLO = 'ps';
export const BTN_CHECKIN = 'pk';
export const MODAL_TEAM_NAME = 'pm';
export const SELECT_TEAM_JOIN = 'pj';

/** Панель регистрации: одно сообщение в канале, дальше всё происходит кнопками. */
export function registrationPanel(tournament: TournamentRow): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const game = TOURNAMENT_GAME_LABELS[tournament.game] ?? tournament.game;
  const solo = tournament.entryMode === 'solo';

  const buttons = new ActionRowBuilder<ButtonBuilder>();
  if (solo) {
    buttons.addComponents(
      new ButtonBuilder().setCustomId(BTN_PANEL_SOLO).setLabel('Записаться').setStyle(ButtonStyle.Success),
    );
  } else {
    buttons.addComponents(
      new ButtonBuilder().setCustomId(BTN_PANEL_CREATE).setLabel('Создать команду').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(BTN_PANEL_FIND).setLabel('Найти команду').setStyle(ButtonStyle.Primary),
    );
  }
  buttons.addComponents(
    new ButtonBuilder().setCustomId(BTN_CHECKIN).setLabel('Я готов').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BTN_PANEL_HELP).setLabel('Что мне делать?').setStyle(ButtonStyle.Secondary),
  );

  const lines = [
    `## ${tournament.name}`,
    `${game} · ${solo ? 'играем по одному' : `команды по ${tournament.teamSize} человек`} · до ${tournament.maxEntrants} участников`,
    '',
    solo
      ? 'Нажми **Записаться** — этого достаточно. Перед стартом нажми **Я готов**.'
      : [
          'Дальше будет так:',
          '**1.** Кто-то один из компании нажимает **Создать команду** и вводит название — он становится капитаном.',
          '**2.** Остальные нажимают **Найти команду** и выбирают, куда вступить. Приглашать никого не надо.',
          `**3.** Когда в составе ${tournament.teamSize} человек, капитан нажимает **Я готов**.`,
          '**4.** В момент старта бот сам разложит сетку, создаст командам голосовые каналы и напишет, кто с кем играет.',
        ].join('\n'),
    '',
    'Не знаешь, что нужно именно тебе — нажми **Что мне делать?**, бот посмотрит и скажет.',
  ];

  return { content: lines.join('\n'), components: [buttons] };
}

/** Модальное окно с названием команды — форма в Discord, без сайта и без входа. */
export function teamNameModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(MODAL_TEAM_NAME)
    .setTitle('Новая команда')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Название команды')
          .setPlaceholder('Например: Медведи')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(60)
          .setRequired(true),
      ),
    );
}

/**
 * Список команд, куда можно вступить. Показывается только тому, кто нажал, — иначе канал
 * заполнится одинаковыми списками. Команды с полным составом в список не попадают: выбор,
 * который заканчивается отказом, хуже отсутствия выбора.
 */
export function teamPicker(
  teams: { entrant: EntrantRow; have: number }[],
  teamSize: number,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const open = teams.filter((team) => team.have < teamSize).slice(0, 25);
  if (open.length === 0) return null;

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SELECT_TEAM_JOIN)
      .setPlaceholder('Выбери команду')
      .addOptions(
        open.map((team) => ({
          label: team.entrant.displayName.slice(0, 100),
          description: `${team.have} из ${teamSize} — свободно ${teamSize - team.have}`,
          value: String(team.entrant.id),
        })),
      ),
  );
}

export interface PlayerState {
  linked: boolean;
  linkCommand: string;
  gameLabel: string;
  entrant: EntrantRow | null;
  isCaptain: boolean;
  rosterSize: number;
  teamSize: number;
  openTeams: number;
  registrationOpen: boolean;
}

/**
 * Следующий шаг для конкретного человека. Порядок проверок — это и есть порядок, в котором
 * новичок упирается в препятствия: сначала привязка (без неё регистрация откажет), потом
 * наличие команды, потом полнота состава, потом готовность.
 */
export function nextStepText(state: PlayerState): string {
  if (!state.registrationOpen) {
    return state.entrant
      ? `Регистрация закрыта, ты в составе **${state.entrant.displayName}**. Дальше бот сам объявит, кто с кем играет.`
      : 'Регистрация уже закрыта. Следующий турнир бот объявит здесь же — не пропустишь.';
  }

  if (!state.linked) {
    return [
      `Сначала привяжи аккаунт ${state.gameLabel} — без этого в турнир не пустят, иначе в сетку попадают чужие ники.`,
      '',
      `Команда: \`${state.linkCommand}\`. Займёт минуту, подтверждение владения бот сделает сам.`,
      'Как привяжешь — вернись сюда и нажми **Что мне делать?** снова.',
    ].join('\n');
  }

  if (!state.entrant) {
    if (state.teamSize === 1) {
      return 'Аккаунт привязан. Нажми **Записаться** — больше ничего не нужно.';
    }
    return [
      'Аккаунт привязан, дальше нужна команда. Два пути:',
      '',
      state.openTeams > 0
        ? `• **Найти команду** — сейчас набирают ${state.openTeams}. Выбираешь из списка, и всё.`
        : '• **Найти команду** — пока никто не набирает, но появятся: заглядывай.',
      '• **Создать команду** — если собираешь своих. Станешь капитаном, остальные вступят кнопкой.',
    ].join('\n');
  }

  const missing = state.teamSize - state.rosterSize;

  if (missing > 0) {
    const who = state.isCaptain ? 'Ты капитан' : `Ты в составе **${state.entrant.displayName}**`;
    return [
      `${who}, состав ${state.rosterSize} из ${state.teamSize} — не хватает ${missing}.`,
      '',
      'Позови своих в этот канал: им надо нажать **Найти команду** и выбрать вашу.',
      'Как соберётесь, капитан нажимает **Я готов**.',
    ].join('\n');
  }

  if (state.entrant.checkedInAt === null) {
    return state.isCaptain
      ? [`Состав собран: ${state.rosterSize} из ${state.teamSize}. Осталось нажать **Я готов**.`, '', 'Без этого команда в сетку не попадёт — так неявившиеся не занимают места.'].join('\n')
      : `Состав собран. Ждём, пока капитан нажмёт **Я готов** — без этого в сетку не попадём.`;
  }

  return [
    `Всё готово: **${state.entrant.displayName}** отмечена и ждёт старта.`,
    '',
    'В момент старта бот создаст вашей команде голосовой канал и напишет, с кем играете. Результат матча потом заявляет любой из вас, соперник подтверждает кнопкой.',
  ].join('\n');
}

/** Подсказка капитану в момент, когда состав только что стал полным. */
export function rosterFullNudge(teamName: string, captainUserId: string): string {
  return [
    `**${teamName}** — состав собран.`,
    `<@${captainUserId}>, нажми **Я готов** на панели регистрации, иначе команда не попадёт в сетку.`,
  ].join('\n');
}

/** Напоминание перед стартом тем, кто не отметился. */
export function checkinReminder(teams: EntrantRow[], minutesLeft: number): string {
  return [
    `До старта ${minutesLeft} мин, а эти команды ещё не нажали **Я готов**:`,
    teams.map((team) => `• **${team.displayName}** — <@${team.captainUserId}>`).join('\n'),
    '',
    'Кто не отметится, в сетку не попадёт.',
  ].join('\n');
}
