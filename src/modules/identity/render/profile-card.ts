import { ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import type { RankInfo } from '../providers/provider.js';
import { hasRankChanged, rankScore } from '../ranks/compare.js';
import { formatAbyss } from '../ranks/genshin.js';
import type { GameAccountRow } from '../services/linking.js';

/** Предел Discord: контейнер вмещает не более 10 компонентов. */
const MAX_COMPONENTS = 10;

const PROVIDER_LABELS: Record<string, string> = {
  steam: 'Steam / Dota 2',
  'riot-lol': 'League of Legends',
  'riot-tft': 'Teamfight Tactics',
  'riot-valorant': 'Valorant',
  enka: 'Genshin Impact',
};

export interface ProfileEntry {
  account: GameAccountRow;
  ranks: RankInfo[];
  /** Ранг 30 дней назад по каждому режиму — для показа динамики. */
  previous: Map<string, RankInfo | null>;
  /**
   * Время, когда ранг был на самом деле получен от сервиса игры (не когда его в
   * последний раз пытались обновить). Задано только тогда, когда сервис сейчас
   * недоступен и показана не текущая, а последняя известная копия из кэша.
   */
  staleSince?: Date;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function formatRank(rank: RankInfo): string {
  if (!rank.tier) return 'без ранга';

  // Бездна пишется этажом и залом через дефис, как её и называют игроки: «12-3». Через
  // пробел это читалось бы как два разных числа, а titleCase над цифрой ничего не даёт.
  if (rank.scale === 'genshin-abyss') return `Бездна ${formatAbyss(rank)}`;

  const parts = [titleCase(rank.tier)];
  if (rank.division) parts.push(rank.division);

  let text = parts.join(' ');
  if (rank.points !== null) {
    // У Dota очки — это место в лидерборде (меньше — лучше), отдельное измерение
    // от LP остальных шкал (см. rankScore в ranks/compare.ts): подписывать его
    // как LP неверно — это не очки, а позиция.
    text += rank.scale === 'dota-mmr' ? ` · ${rank.points}-е место в лидерборде` : ` · ${rank.points} LP`;
  }
  if (rank.source === 'manual') text += ' _(со слов игрока)_';

  return text;
}

/**
 * Направление динамики за период. Сравнение через один только rankScore
 * противоречило бы собственному тесту брифа: rankScore учитывает LP даже
 * внутри одного дивизиона (см. ranks/compare.ts), поэтому GOLD II 10→40 LP
 * читался бы как рост, хотя ранг не изменился. hasRankChanged (Task 3) — та
 * же логика, что уже решает, менять ли роль за ранг: дрейф очков внутри
 * дивизиона не считается изменением, поэтому сначала проверяем именно её,
 * а к rankScore обращаемся только чтобы понять направление настоящей смены.
 */
export function formatDelta(previous: RankInfo | null, current: RankInfo): string {
  if (!previous) return 'новый';
  if (!hasRankChanged(previous, current)) return 'без изменений';

  const before = rankScore(previous);
  const after = rankScore(current);

  if (after > before) return `↑ с ${formatRank(previous)}`;
  if (after < before) return `↓ с ${formatRank(previous)}`;
  return 'без изменений';
}

function formatTime(at: Date): string {
  return at.toISOString().slice(11, 16);
}

function entryLines(entry: ProfileEntry): string {
  const label = PROVIDER_LABELS[entry.account.provider] ?? entry.account.provider;
  const verified = entry.account.verifiedAt ? '' : ' — _не подтверждён_';
  const header = `**${label}** · ${entry.account.displayName}${verified}`;

  if (entry.ranks.length === 0) {
    return `${header}\nРанга нет или он скрыт настройками приватности.`;
  }

  const ranks = entry.ranks
    .map((rank) => `• ${rank.mode}: ${formatRank(rank)} — ${formatDelta(entry.previous.get(rank.mode) ?? null, rank)}`)
    .join('\n');

  const stale = entry.staleSince ? `\n_Данные на ${formatTime(entry.staleSince)} — сервис игры не ответил._` : '';

  return `${header}\n${ranks}${stale}`;
}

export function buildProfileCard(input: { displayName: string; entries: ProfileEntry[] }): ContainerBuilder {
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Профиль ${input.displayName}`));

  if (input.entries.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Игровых аккаунтов пока нет. Привяжи первый: `/link steam`, `/link riot` или `/link valorant`.',
      ),
    );
    return container;
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  // Заголовок и разделитель уже заняли два места; один слот резервируется под сводку.
  const budget = MAX_COMPONENTS - 3;
  const shown = input.entries.slice(0, budget);
  const hidden = input.entries.length - shown.length;

  for (const entry of shown) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(entryLines(entry)));
  }

  if (hidden > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`_И ещё привязок: ${hidden}. Показаны самые свежие._`),
    );
  }

  return container;
}
