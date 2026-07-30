import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ServerStatus } from './bridge.js';
import type { WelcomeSettingsRow } from './schema.js';

export const BTN_FIRST_STEP = 'welcome:step';

const PROVIDER_COMMANDS: Record<string, string> = {
  dota2: '`/link steam` — Dota 2',
  lol: '`/link riot` — League of Legends и TFT',
  valorant: '`/link valorant` — Valorant',
};

/**
 * Публичное приветствие: коротко и с одной кнопкой. Длинный текст в общем канале никто
 * не читает, а список из десяти команд читают тем меньше, чем он длиннее. Поэтому здесь
 * только «сервер про турниры» и кнопка, за которой личный разбор.
 */
export function welcomeMessage(
  settings: WelcomeSettingsRow,
  userId: string,
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const where = [
    settings.rulesChannelId ? `Правила: <#${settings.rulesChannelId}>` : null,
    settings.tournamentChannelId ? `Турниры: <#${settings.tournamentChannelId}>` : null,
  ].filter(Boolean);

  const content = [
    settings.greeting ?? `Привет, <@${userId}>!`,
    settings.greeting ? `<@${userId}>` : null,
    '',
    'Здесь каждый день турнир: бот сам объявляет дисциплину голосованием, открывает регистрацию и раскладывает сетку. Участвовать можно даже если ты никого тут не знаешь — команда собирается кнопками, а не договорённостями.',
    ...(where.length > 0 ? ['', where.join(' · ')] : []),
    '',
    'Не знаешь, с чего начать — нажми кнопку, бот посмотрит именно твой случай.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    content,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(BTN_FIRST_STEP)
          .setLabel('С чего начать?')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

/**
 * Один следующий шаг для этого человека — не список возможностей.
 *
 * Порядок проверок повторяет порядок, в котором новичок упирается в препятствия:
 * сначала нет привязки (без неё не будет ни ранга, ни роли, ни жеребьёвки), потом нет
 * команды, потом состав не отмечен. Называть всё сразу — значит не назвать ничего:
 * человек прочитает первый абзац и закроет.
 */
export function firstStep(status: ServerStatus, settings: WelcomeSettingsRow): string {
  const tournamentChannel = settings.tournamentChannelId
    ? `<#${settings.tournamentChannelId}>`
    : 'канале турниров';

  if (status.verifiedProviders.length === 0) {
    return [
      '## Шаг первый: привяжи игровой аккаунт',
      'Это нужно один раз. После привязки бот сам подтянет твой ранг, выдаст роль по нему и будет обновлять её, когда ранг меняется. А ещё жеребьёвка сможет разводить сильные команды по разным половинам сетки — без рангов она этого не умеет.',
      '',
      'Выбери свою игру:',
      ...Object.values(PROVIDER_COMMANDS).map((line) => `• ${line}`),
      '',
      'Steam подтверждается входом через сам Steam, Valorant — ручным вводом ранга. Пароль бот не видит и не спрашивает.',
    ].join('\n');
  }

  if (!status.tournament) {
    return [
      '## Аккаунт привязан — дальше ждём турнир',
      `Бот объявляет его сам: сначала голосование по дисциплине, потом регистрация, потом сетка. Смотри ${tournamentChannel}.`,
      '',
      'Пока можно:',
      '• `/profile` — своя карточка с рангами',
      '• `/rank` — уровень и монеты за активность на сервере',
      '• `/lfg post` — собрать компанию на пару игр прямо сейчас',
      '• `/stats` — турнирный след, когда он появится',
    ].join('\n');
  }

  if (status.tournament.state === 'running') {
    return [
      '## Турнир уже идёт',
      `Вписаться в него нельзя — сетка построена. Следующий будет объявлен в ${tournamentChannel}, и к нему ты уже готов: аккаунт привязан.`,
      '',
      'Чтобы не пропустить, посмотри роли для упоминаний: `/lfg roles`.',
    ].join('\n');
  }

  if (!status.inRoster) {
    return [
      '## Регистрация открыта — тебе нужна команда',
      `Иди в ${tournamentChannel}, под объявлением две кнопки.`,
      '',
      '**Найти команду** — покажет, кто ещё набирает. Полные составы в списке не показываются, так что откажут тебе только если кто-то успел раньше.',
      '**Создать команду** — если хочешь быть капитаном: введёшь название, и остальные будут вступать к тебе.',
      '',
      'Приглашать никого не надо и договариваться заранее тоже.',
    ].join('\n');
  }

  return [
    '## Ты в составе',
    'Осталось одно: перед стартом капитан нажимает **Я готов** под объявлением. Не отметились — в сетку не попадёте, это правило одинаково для всех.',
    '',
    `Когда турнир начнётся, бот сам создаст вашей команде голосовой канал и напишет, кто с кем играет.`,
  ].join('\n');
}
