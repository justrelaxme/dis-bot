import type { Guild } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { AnnounceResult, TournamentEventsGateway } from '../discord/events.js';
import { registrationPanel } from '../discord/onboarding.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import type {
  EntryMode,
  SeedingMode,
  TournamentFormat,
  TournamentGame,
  TournamentRow,
} from '../schema.js';
import type { MessagesService } from './messages.js';
import type { TournamentsService } from './tournaments.js';

/**
 * Запуск турнира: создать, открыть регистрацию, вывесить панель и афишу.
 *
 * Вынесено из обработчика слэш-команды, потому что входов стало два. Формат теперь собирают на
 * витрине, и оттуда же его хотят запустить — а обработчик команды умеет отвечать только
 * взаимодействию Discord, которого у запроса с сайта нет.
 *
 * Всё, что зависит от входа, приходит сюда снаружи:
 *
 * - **куда отправить панель** — колбэком `deliver`. У команды это ответ на неё, у сайта —
 *   сообщение в канал объявлений. Разница существенная: ответ команды видит только тот, кто её
 *   набрал, если ответ эфемерный, а панель регистрации обязана висеть у всех на виду. Свести
 *   оба случая к одному вызову `channel.send` было бы можно, но тогда ответ на `/tournament
 *   create` стал бы пустым, а у него сейчас есть смысл — он и есть панель.
 * - **где будут комнаты** — идентификаторами каналов. Команда берёт их из места вызова, сайт —
 *   из настроек ежедневного автомата: другого способа узнать, где на сервере проводят турниры,
 *   у запроса из браузера нет.
 *
 * Проверка «второй турнир одновременно» живёт здесь же, а не у каждого входа: два турнира — это
 * участники в двух сетках сразу и невозможность понять, к какому из них относится `/match
 * report`. Пропустить её нельзя ни с какого входа, поэтому она стоит там, где её не обойти.
 */

/** Настройки турнира — уже разрешённые: откуда они взялись, сервису знать незачем. */
export interface LaunchSettings {
  name: string;
  game: TournamentGame;
  format: TournamentFormat;
  entryMode: EntryMode;
  teamSize: number;
  maxEntrants: number;
  seeding: SeedingMode;
  bestOf: number;
  abilities: boolean;
  autoTeams: boolean;
  requireVerified: boolean;
  /** Потолок стоимости состава в очках у Genshin. `null` — без потолка. */
  costCap: number | null;
  registrationHours: number;
}

/** Где турнир будет жить: объявления, ветки матчей, комнаты команд. */
export interface LaunchPlaces {
  announceChannelId?: string | null;
  matchParentId?: string | null;
  teamCategoryId?: string | null;
}

/** Куда ушла панель регистрации: нужно, чтобы потом её убрать. */
export interface DeliveredPanel {
  channelId: string;
  messageId: string;
}

export interface LaunchDeps {
  tournaments: TournamentsService;
  publicBaseUrl: string;
  messages?: MessagesService | undefined;
  events?: TournamentEventsGateway | undefined;
}

export interface LaunchResult {
  tournament: TournamentRow;
  closesAt: Date;
  /**
   * Что вышло с афишей. `null` — афиши не заводили вовсе. Отказ не мешает турниру, но сказать
   * о нём надо: право «Управление событиями» выдаёт человек, а не бот.
   */
  billboard: AnnounceResult | null;
}

/** Текст панели с кнопками: одинаковый на обоих входах, и собирается один раз здесь. */
export function panelMessage(
  tournament: TournamentRow,
  closesAt: Date,
  publicBaseUrl: string,
): { content: string; components: ReturnType<typeof registrationPanel>['components'] } {
  const panel = registrationPanel(tournament);
  return {
    content: [
      panel.content,
      '',
      `Старт <t:${Math.floor(closesAt.getTime() / 1_000)}:t> · сетка: ${publicBaseUrl}/t/${tournament.id}`,
    ].join('\n'),
    components: panel.components,
  };
}

/** Имя по умолчанию: с формата берётся его название, без формата — дисциплина. */
export function defaultName(game: TournamentGame, presetName?: string | null): string {
  return presetName
    ? `${presetName} · ${TOURNAMENT_GAME_LABELS[game]}`
    : `Турнир по ${TOURNAMENT_GAME_LABELS[game]}`;
}

export async function launchTournament(
  deps: LaunchDeps,
  guild: Guild,
  input: {
    settings: LaunchSettings;
    places: LaunchPlaces;
    createdBy: string;
    /** Отправляет панель регистрации и говорит, куда она легла. */
    deliver: (message: ReturnType<typeof panelMessage>) => Promise<DeliveredPanel>;
  },
): Promise<LaunchResult> {
  const running = await deps.tournaments.current(guild.id);
  if (running) {
    throw new UserError(`На сервере уже есть турнир «${running.name}». Сначала заверши или отмени его.`);
  }

  const { settings, places } = input;
  const tournament = await deps.tournaments.create({
    guildId: guild.id,
    name: settings.name,
    game: settings.game,
    format: settings.format,
    entryMode: settings.entryMode,
    teamSize: settings.teamSize,
    maxEntrants: settings.maxEntrants,
    seeding: settings.seeding,
    bestOf: settings.bestOf,
    abilities: settings.abilities,
    autoTeams: settings.autoTeams,
    requireVerified: settings.requireVerified,
    ...(settings.costCap === null ? {} : { costCap: settings.costCap }),
    createdBy: input.createdBy,
    ...(places.announceChannelId ? { announceChannelId: places.announceChannelId } : {}),
    ...(places.matchParentId ? { matchParentId: places.matchParentId } : {}),
    ...(places.teamCategoryId ? { teamCategoryId: places.teamCategoryId } : {}),
  });

  const closesAt = new Date(Date.now() + settings.registrationHours * 60 * 60 * 1_000);
  await deps.tournaments.openRegistration(tournament.id, closesAt);

  // Панель с кнопками вместо инструкции текстом: новичку не надо разбираться, какую команду
  // набрать, — он нажимает «Что мне делать?» и получает свой следующий шаг.
  const sent = await input.deliver(panelMessage(tournament, closesAt, deps.publicBaseUrl));

  // Афиша во вкладке «События»: сама напомнит подписавшимся и покажет отсчёт.
  let billboard: AnnounceResult | null = null;
  if (deps.events) {
    billboard = await deps.events.announce(
      guild,
      tournament,
      closesAt,
      `${deps.publicBaseUrl}/t/${tournament.id}`,
    );
    if (billboard.ok) await deps.tournaments.attachScheduledEvent(tournament.id, billboard.eventId);
  }

  // Панель с живыми кнопками — сор, и самый вредный: по ней нажимают через сутки. Запись не
  // должна ронять создание турнира, поэтому отказ здесь проглатывается: турнир создан, панель
  // отправлена, а неубранное сообщение — не повод сообщать организатору об ошибке.
  try {
    await deps.messages?.remember(tournament.id, sent, { transient: true });
  } catch {
    // Намеренно тихо: см. выше.
  }

  return { tournament, closesAt, billboard };
}
