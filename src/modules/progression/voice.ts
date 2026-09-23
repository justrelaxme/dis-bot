import type { ProgressionService } from './service.js';

/** Что сделать с голосовой сессией при смене состояния в голосе. */
export type VoiceStep = { kind: 'close'; channelId: string } | { kind: 'open'; channelId: string };

/**
 * Шаги по переходу из канала в канал — по порядку.
 *
 * Порядок здесь и есть вся суть: при переключении старая сессия закрывается **до** того,
 * как откроется новая. Сессия у человека одна на сервер (уникальность по серверу и
 * человеку), и закрытие удаляет её, не глядя на канал. Открой новую первой — и закрытие
 * померяло бы только что открытую (ноль минут), а заодно стёрло бы её: терялось бы и время
 * в канале, откуда ушли, и время в канале, куда пришли.
 *
 * Тот же канал до и после — это мут, наушники или трансляция, а не переход: сессия идёт
 * дальше как шла.
 */
export function voiceTransition(beforeChannelId: string | null, afterChannelId: string | null): VoiceStep[] {
  if (beforeChannelId === afterChannelId) return [];
  const steps: VoiceStep[] = [];
  if (beforeChannelId) steps.push({ kind: 'close', channelId: beforeChannelId });
  if (afterChannelId) steps.push({ kind: 'open', channelId: afterChannelId });
  return steps;
}

/**
 * Проводит переход через сервис и возвращает минуты закрытой сессии (0 — если закрывать
 * было нечего). Одно `now` на оба шага: новая сессия начинается ровно там, где кончилась
 * старая.
 */
export async function applyVoiceTransition(
  sessions: Pick<ProgressionService, 'openVoiceSession' | 'closeVoiceSession'>,
  guildId: string,
  userId: string,
  beforeChannelId: string | null,
  afterChannelId: string | null,
  now: Date,
): Promise<number> {
  let minutes = 0;
  for (const step of voiceTransition(beforeChannelId, afterChannelId)) {
    if (step.kind === 'close') minutes = await sessions.closeVoiceSession(guildId, userId, now);
    else await sessions.openVoiceSession(guildId, userId, step.channelId, now);
  }
  return minutes;
}
