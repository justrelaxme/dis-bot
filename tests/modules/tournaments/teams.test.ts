import { describe, expect, it } from 'vitest';
import {
  autoTeamName,
  formTeams,
  fullTeams,
  type Signup,
} from '../../../src/modules/tournaments/teams.js';

/**
 * Сбор команд из одиночек. Главное свойство — ровность: раздача обязана давать составы
 * сопоставимой силы, потому что состав из пяти сильнейших против пяти слабейших это испорченный
 * вечер для десяти человек, и переиграть его нельзя.
 *
 * Проверяется именно свойство, а не конкретное распределение: порядок раздачи можно поменять,
 * ровность — нет.
 */

function players(strengths: (number | null)[]): Signup[] {
  return strengths.map((strength, index) => ({
    entrantId: index + 1,
    userId: `user-${index + 1}`,
    strength,
  }));
}

describe('сколько команд выйдет', () => {
  it('только полные: неполный состав это не турнир, а обида', () => {
    expect(fullTeams(10, 5)).toBe(2);
    expect(fullTeams(12, 5)).toBe(2);
    expect(fullTeams(9, 5)).toBe(1);
    expect(fullTeams(4, 5)).toBe(0);
  });

  it('нулевой размер команды не делит ни на что', () => {
    expect(fullTeams(10, 0)).toBe(0);
  });
});

describe('раздача по составам', () => {
  it('составы полные, лишние остаются вне сетки', () => {
    const formation = formTeams(players([100, 90, 80, 70, 60, 50, 40]), 3);

    expect(formation.teams).toHaveLength(2);
    expect(formation.teams.every((team) => team.members.length === 3)).toBe(true);
    // Седьмой лишний: добрать им состав нельзя, а место в неполном выглядело бы участием.
    expect(formation.benched.map((signup) => signup.strength)).toEqual([40]);
  });

  it('никто не попадает в два состава сразу', () => {
    const formation = formTeams(players([90, 85, 80, 75, 70, 65, 60, 55, 50, 45]), 5);
    const assigned = formation.teams.flatMap((team) => team.members.map((member) => member.entrantId));

    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned).toHaveLength(10);
  });

  /**
   * Ключевая проверка: составы обязаны быть сопоставимы по силе, иначе вечер решён до первого
   * матча. Ранги берутся псевдослучайными, но воспроизводимыми — настоящий MMR не арифметическая
   * прогрессия, и проверять надо на том, что бывает.
   *
   * Восемь процентов — с запасом: измеренный разброс держится около одного процента.
   */
  it('на настоящих рангах составы расходятся меньше чем на восемь процентов', () => {
    let seed = 12_345;
    const next = (): number => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff);

    for (let trial = 0; trial < 200; trial += 1) {
      const teams = 2 + (trial % 5);
      const teamSize = 5;
      const formation = formTeams(
        players(Array.from({ length: teams * teamSize }, () => Math.round(1_000 + next() * 6_000))),
        teamSize,
      );

      const sums = formation.teams.map((team) => team.strength);
      const average = sums.reduce((total, sum) => total + sum, 0) / sums.length;
      const spread = Math.max(...sums) - Math.min(...sums);

      expect(spread / average, `разброс при ${teams}×${teamSize}, попытка ${trial}`).toBeLessThan(0.08);
    }
  });

  /**
   * Худший возможный вход: сила убывает ровным шагом. Здесь остаётся разброс, и он неустраним
   * одним проходом по структурной причине. К последнему кругу раздачи составы почти равны, а
   * распределить между ними последние `teams` соседних по силе значений без перекоса нельзя:
   * крайние из них отличаются на `(teams - 1)` шагов, и кому-то этот перекос достанется.
   *
   * Граница проверяется как раз затем, чтобы она не поехала вверх: три состава по пять при шаге
   * в двадцать пять это пятьдесят очков разницы на состав из двенадцати тысяч, то есть меньше
   * процента.
   */
  it('на ровном шаге разброс не превышает структурный предел', () => {
    const step = 25;
    for (let teams = 2; teams <= 8; teams += 1) {
      for (const teamSize of [2, 3, 5]) {
        const formation = formTeams(
          players(Array.from({ length: teams * teamSize }, (_, index) => 1_000 - index * step)),
          teamSize,
        );

        const sums = formation.teams.map((team) => team.strength);
        const spread = Math.max(...sums) - Math.min(...sums);
        expect(spread, `разброс при ${teams}×${teamSize}`).toBeLessThanOrEqual(step * (teams - 1));
      }
    }
  });

  it('сильнейший игрок идёт первым в составе — он же будет капитаном', () => {
    const formation = formTeams(players([100, 90, 80, 70]), 2);

    for (const team of formation.teams) {
      const strengths = team.members.map((member) => member.strength ?? 0);
      expect(strengths[0]).toBeGreaterThanOrEqual(strengths[1] as number);
    }
  });

  /**
   * Игрок без ранга считается средним, а не слабейшим. Ноль означал бы «худший», а на деле
   * означает «неизвестно», и такой игрок утягивал бы свою команду вниз без причины.
   */
  it('игрок без ранга считается средним, а не нулевым', () => {
    const formation = formTeams(players([100, null, 100, null]), 2);
    const sums = formation.teams.map((team) => team.strength);

    expect(Math.max(...sums) - Math.min(...sums)).toBe(0);
    expect(sums.every((sum) => sum === 200)).toBe(true);
  });

  it('когда ранга нет ни у кого, раздача всё равно проходит', () => {
    const formation = formTeams(players([null, null, null, null]), 2);

    expect(formation.teams).toHaveLength(2);
    expect(formation.benched).toEqual([]);
  });

  /**
   * Два прогона на одних данных обязаны давать одни составы. Иначе перезапуск процесса между
   * записью и стартом переставил бы людей, и объяснить это было бы нечем.
   */
  it('раздача повторяема при равной силе', () => {
    const same = players([50, 50, 50, 50, 50, 50]);
    const first = formTeams(same, 3);
    const second = formTeams(same, 3);

    expect(first.teams.map((team) => team.members.map((member) => member.entrantId))).toEqual(
      second.teams.map((team) => team.members.map((member) => member.entrantId)),
    );
  });

  it('меньше чем на один состав — никого не делим', () => {
    const formation = formTeams(players([100, 90]), 5);

    expect(formation.teams).toEqual([]);
    expect(formation.benched).toHaveLength(2);
  });
});

describe('названия автосоставов', () => {
  it('первые составы получают имена, дальние — номера', () => {
    expect(autoTeamName(0)).toBe('Альфа');
    expect(autoTeamName(1)).toBe('Браво');
    expect(autoTeamName(50)).toBe('Состав 51');
  });

  it('имена не повторяются', () => {
    const names = Array.from({ length: 12 }, (_, index) => autoTeamName(index));

    expect(new Set(names).size).toBe(names.length);
  });
});
