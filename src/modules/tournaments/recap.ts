import { plural } from '../../core/russian.js';
import { TOURNAMENT_GAME_LABELS } from './games.js';
import type { TournamentGame } from './schema.js';

/**
 * Итог недели — текст для канала объявлений. Чистая функция: данные приходят готовыми, и
 * проверить, что в итоге есть и чего нет, можно без базы и Discord.
 *
 * Итог, который не читают, хуже его отсутствия, поэтому в нём только то, что интересно: кто
 * победил, у кого серия, что пикали и банили чаще всего, кто лучше всех угадывал, где был апсет
 * и кто ведёт сезон. Пустые разделы не показываются вовсе, а неделя без турниров не даёт итога
 * совсем — «на этой неделе ничего не было» никто читать не станет.
 */

export interface WeekData {
  tournaments: { name: string; game: TournamentGame; champion: string | null; entrants: number }[];
  /** Кто взял больше одного титула за неделю — это и есть серия. */
  streaks: { userId: string; titles: number }[];
  /** Самое частое по дисциплинам: пик и бан. */
  drafts: { game: TournamentGame; pick: { label: string; count: number } | null; ban: { label: string; count: number } | null }[];
  predictor: { userId: string; coins: number; correct: number; total: number } | null;
  /** Самая большая победа слабейшего по посеву. */
  upset: { winner: string; loser: string; winnerSeed: number; loserSeed: number; tournament: string } | null;
  season: { name: string; leaders: { userId: string; points: number }[] } | null;
}

export function buildRecap(week: WeekData): string | null {
  if (week.tournaments.length === 0) return null;

  const lines = ['## Итог недели'];

  lines.push('', '**Чемпионы**');
  for (const tournament of week.tournaments) {
    const game = TOURNAMENT_GAME_LABELS[tournament.game] ?? tournament.game;
    lines.push(`🏆 ${tournament.name} (${game}, ${tournament.entrants} уч.) — **${tournament.champion ?? 'не определён'}**`);
  }

  if (week.streaks.length > 0) {
    lines.push(
      '',
      ...week.streaks.map(
        (row) => `🔥 <@${row.userId}> — ${row.titles} ${plural(row.titles, 'титул', 'титула', 'титулов')} за неделю.`,
      ),
    );
  }

  if (week.upset) {
    const u = week.upset;
    lines.push(
      '',
      `**Апсет недели** — ${u.winner} (сид ${u.winnerSeed}) обыграл ${u.loser} (сид ${u.loserSeed}) в «${u.tournament}».`,
    );
  }

  const drafts = week.drafts.filter((row) => row.pick || row.ban);
  if (drafts.length > 0) {
    lines.push('', '**Драфт**');
    for (const row of drafts) {
      const parts = [
        row.pick ? `чаще всех брали **${row.pick.label}** (${row.pick.count})` : null,
        row.ban ? `банили — **${row.ban.label}** (${row.ban.count})` : null,
      ].filter(Boolean);
      lines.push(`${TOURNAMENT_GAME_LABELS[row.game] ?? row.game}: ${parts.join(', ')}.`);
    }
  }

  if (week.predictor && week.predictor.coins > 0) {
    const p = week.predictor;
    lines.push('', `**Прогнозист недели** — <@${p.userId}>: угадал ${p.correct} из ${p.total}, +${p.coins} монет.`);
  }

  if (week.season && week.season.leaders.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    lines.push(
      '',
      `**Сезон «${week.season.name}»**: ${week.season.leaders
        .slice(0, 3)
        .map((row, index) => `${medals[index] ?? ''} <@${row.userId}> ${row.points}`)
        .join(' · ')} — таблица: \`/season table\``,
    );
  }

  return lines.join('\n');
}
