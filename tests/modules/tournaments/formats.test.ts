import { describe, expect, it } from 'vitest';
import { UserError } from '../../../src/core/errors.js';
import {
  normalizeBricks,
  previewOf,
  warningsFor,
  waveCount,
  type FormatBricks,
} from '../../../src/modules/tournaments/services/formats.js';

/**
 * Правила формата. Проверять их надо жёстче, чем настройки одного турнира: формат
 * запускается много раз, и противоречие внутри него портит не вечер, а все вечера, пока
 * кто-нибудь не догадается посмотреть в настройки.
 */

const team = (over: Partial<FormatBricks> = {}): FormatBricks => ({
  game: 'dota2',
  entryMode: 'team',
  teamSize: 5,
  maxEntrants: 16,
  format: 'single-elim',
  bestOf: 1,
  ...over,
});

describe('согласование кирпичиков', () => {
  /** Состав из одного и есть одиночный турнир: другого смысла у «одиночки по трое» нет. */
  it('одиночному турниру состав молча ставится в один', () => {
    const bricks = normalizeBricks(team({ entryMode: 'solo', teamSize: 5 }));

    expect(bricks.teamSize).toBe(1);
    expect(bricks.entryMode).toBe('solo');
  });

  it('командный турнир с составом из одного — отказ, а не догадка', () => {
    expect(() => normalizeBricks(team({ teamSize: 1 }))).toThrow(UserError);
  });

  /**
   * Автосбор в турнире один на один значит либо что режим указан неверно, либо что настройка
   * лишняя. Угадывать, что именно, — значит решать за организатора, и молчаливая правка
   * однажды соберёт составы там, где их не просили.
   */
  it('автосбор составов у одиночек — отказ с объяснением', () => {
    expect(() => normalizeBricks(team({ entryMode: 'solo', autoTeams: true }))).toThrow(/Автосбор/);
  });

  it('карт в матче только 1, 3 или 5', () => {
    expect(normalizeBricks(team({ bestOf: 3 })).bestOf).toBe(3);
    expect(() => normalizeBricks(team({ bestOf: 2 }))).toThrow(UserError);
    expect(() => normalizeBricks(team({ bestOf: 7 }))).toThrow(UserError);
  });

  it('мест в сетке от двух до 64', () => {
    expect(() => normalizeBricks(team({ maxEntrants: 1 }))).toThrow(UserError);
    expect(() => normalizeBricks(team({ maxEntrants: 65 }))).toThrow(UserError);
    expect(normalizeBricks(team({ maxEntrants: 2 })).maxEntrants).toBe(2);
    expect(normalizeBricks(team({ maxEntrants: 64 })).maxEntrants).toBe(64);
  });

  it('регистрация от часа до трёх суток', () => {
    expect(() => normalizeBricks(team({ registrationHours: 0 }))).toThrow(UserError);
    expect(() => normalizeBricks(team({ registrationHours: 73 }))).toThrow(UserError);
  });

  it('состав больше десяти не бывает ни в одной дисциплине', () => {
    expect(() => normalizeBricks(team({ teamSize: 11 }))).toThrow(UserError);
  });

  it('дробные числа обрезаются, а не проходят в базу как есть', () => {
    const bricks = normalizeBricks(team({ teamSize: 5.7, maxEntrants: 16.2, registrationHours: 2.9 }));

    expect(bricks.teamSize).toBe(5);
    expect(bricks.maxEntrants).toBe(16);
    expect(bricks.registrationHours).toBe(2);
  });

  it('дисциплина необязательна: формат бывает про форму вечера, а не про игру', () => {
    expect(normalizeBricks(team({ game: null })).game).toBeNull();
    expect(normalizeBricks({ ...team(), game: undefined }).game).toBeNull();
  });

  it('пустая заметка становится отсутствием заметки, а не пустой строкой', () => {
    expect(normalizeBricks(team({ note: '   ' })).note).toBeNull();
    expect(normalizeBricks(team({ note: '  вечером по пятницам ' })).note).toBe('вечером по пятницам');
  });

  it('слишком длинная заметка не сохраняется', () => {
    expect(() => normalizeBricks(team({ note: 'я'.repeat(201) }))).toThrow(UserError);
  });
});

describe('предупреждения', () => {
  /**
   * Настройка значит что-то только у Valorant: у Dota и Genshin способности в самой игре не
   * выключаются. Переключатель при этом стоит у всех дисциплин, и раньше он отменял драфт
   * везде — формат по Genshin с выключенными способностями оставался без драфта, и ссылки
   * капитанам не приходили.
   */
  it('о выключенных способностях у Valorant говорится, что драфта не будет', () => {
    const warnings = warningsFor(normalizeBricks(team({ game: 'valorant', abilities: false })));

    expect(warnings.join(' ')).toMatch(/драфта у неё не будет/);
  });

  it('у остальных дисциплин сказано, что настройка ни на что не влияет', () => {
    const warnings = warningsFor(normalizeBricks(team({ game: 'dota2', abilities: false })));

    expect(warnings.join(' ')).toMatch(/ни на что не влияет/);
  });

  /** Этаж Бездны проходит один человек: командный Genshin означает вечер без заявок составов. */
  it('про командный Genshin предупреждает', () => {
    const warnings = warningsFor(normalizeBricks(team({ game: 'genshin', entryMode: 'team', teamSize: 4 })));

    expect(warnings.join(' ')).toMatch(/Одиночки/);
  });

  it('про одиночный Genshin не предупреждает', () => {
    const warnings = warningsFor(normalizeBricks(team({ game: 'genshin', entryMode: 'solo' })));

    expect(warnings.join(' ')).not.toMatch(/Одиночки/);
  });

  it('второй шанс плюс матчи до двух побед — предупреждение про длину вечера', () => {
    const warnings = warningsFor(normalizeBricks(team({ format: 'double-elim', bestOf: 3 })));

    expect(warnings.join(' ')).toMatch(/пять/);
  });

  it('у обычного формата предупреждений про запреты нет', () => {
    const warnings = warningsFor(normalizeBricks(team({ autoTeams: true })));

    expect(warnings.join(' ')).not.toMatch(/драфта не будет/);
  });
});

describe('сколько волн матчей', () => {
  it('на выбывание это log2 участников', () => {
    expect(waveCount(2, 'single-elim')).toBe(1);
    expect(waveCount(8, 'single-elim')).toBe(3);
    expect(waveCount(16, 'single-elim')).toBe(4);
  });

  /** Неполная сетка добирается до ближайшей степени двойки — круги от этого не исчезают. */
  it('пять участников — это три круга, а не два с половиной', () => {
    expect(waveCount(5, 'single-elim')).toBe(3);
  });

  it('второй шанс примерно удваивает вечер', () => {
    expect(waveCount(8, 'double-elim')).toBeGreaterThan(waveCount(8, 'single-elim') * 1.5);
  });

  it('меньше двух участников — волн нет', () => {
    expect(waveCount(1, 'single-elim')).toBe(0);
  });
});

describe('что получится', () => {
  it('в одной фразе есть дисциплина и размер события', () => {
    const preview = previewOf(normalizeBricks(team({ maxEntrants: 8 })));

    expect(preview.headline).toContain('Dota 2');
    expect(preview.headline).toContain('8 составов по 5');
  });

  it('без дисциплины так и сказано, а не подставлена первая', () => {
    const preview = previewOf(normalizeBricks(team({ game: null })));

    expect(preview.headline).toContain('Дисциплина по выбору');
  });

  /**
   * Двойное устранение на двоих вырождается в ту же пару второй раз, и настоящий турнир
   * играет их на выбывание. Предпросмотр обязан говорить то же самое — иначе он обещает
   * формат, которого не будет.
   */
  it('второй шанс на двоих показывается выбыванием — как и сыграется', () => {
    const preview = previewOf(normalizeBricks(team({ maxEntrants: 2, format: 'double-elim' })));

    expect(preview.lines.join(' ')).toContain('на выбывание');
  });

  it('у Genshin в драфте персонажи, у Dota — герои', () => {
    const genshin = previewOf(normalizeBricks(team({ game: 'genshin', entryMode: 'solo' })));
    const dota = previewOf(normalizeBricks(team({ game: 'dota2' })));

    expect(genshin.lines.join(' ')).toContain('персонажи');
    expect(dota.lines.join(' ')).toContain('герои');
  });

  it('у TFT сказано, что драфта нет вовсе', () => {
    const preview = previewOf(normalizeBricks(team({ game: 'tft', entryMode: 'solo' })));

    expect(preview.lines.join(' ')).toMatch(/Драфт: у этой дисциплины его нет/);
  });

  it('выключенные способности отменяют драфт Valorant, и это видно в предпросмотре', () => {
    const preview = previewOf(normalizeBricks(team({ game: 'valorant', abilities: false })));

    expect(preview.lines.join(' ')).toMatch(/Драфт: нет/);
  });

  /**
   * У Dota и Genshin способности в игре не выключаются. Пока переключатель отменял драфт везде,
   * формат по Genshin с ним оставался без драфта — и ссылки капитанам не приходили.
   */
  it('у остальных дисциплин выключенные способности драфт не отменяют', () => {
    const preview = previewOf(normalizeBricks(team({ game: 'genshin', entryMode: 'solo', abilities: false })));

    expect(preview.lines.join(' ')).toContain('персонажи');
    expect(preview.lines.join(' ')).not.toMatch(/Драфт: нет/);
  });

  it('людей считает по составам, а не по участникам сетки', () => {
    const preview = previewOf(normalizeBricks(team({ maxEntrants: 8, teamSize: 5 })));

    expect(preview.lines.join(' ')).toContain('до 40 человек');
  });

  it('матч до двух побед описан счётом, а не числом карт', () => {
    const preview = previewOf(normalizeBricks(team({ bestOf: 3 })));

    expect(preview.lines.join(' ')).toContain('до 2 побед из 3');
  });

  it('предупреждения приходят вместе с предпросмотром: их читают там же', () => {
    const preview = previewOf(normalizeBricks(team({ abilities: false })));

    expect(preview.warnings.length).toBeGreaterThan(0);
  });
});

/**
 * Иммуны: персонажи, которых соперник забанить не сможет. Сколько их — решает организатор, кого
 * именно — игрок в своей заявке. Правило из турниров сообщества.
 */
describe('иммуны в формате', () => {
  it('по умолчанию иммунов нет', () => {
    expect(normalizeBricks(team()).immunities).toBe(0);
  });

  it('число сохраняется как задано', () => {
    expect(normalizeBricks(team({ immunities: 2 })).immunities).toBe(2);
  });

  /**
   * Восемь иммунов при восьми пиках отменяют баны целиком, и драфт превращается в обмен ходами
   * без смысла. Предел на единицу меньше отряда: у банов всегда остаётся хотя бы одна цель.
   */
  it('иммунов не больше, чем персонажей в отряде минус один', () => {
    expect(normalizeBricks(team({ immunities: 99 })).immunities).toBe(7);
  });

  it('отрицательное число становится нулём', () => {
    expect(normalizeBricks(team({ immunities: -3 })).immunities).toBe(0);
  });

  it('предпросмотр говорит про иммуны, когда они есть', () => {
    const preview = previewOf(normalizeBricks(team({ game: 'genshin', entryMode: 'solo', immunities: 2 })));

    expect(preview.lines.join(' ')).toMatch(/Иммуны: 2/);
  });

  it('без иммунов предпросмотр про них молчит', () => {
    const preview = previewOf(normalizeBricks(team({ game: 'genshin', entryMode: 'solo' })));

    expect(preview.lines.join(' ')).not.toMatch(/Иммуны/);
  });

  /** Иммуны считаются по заявке, а заявки бывают только у Genshin. */
  it('про иммуны в чужой дисциплине предупреждает', () => {
    const warnings = warningsFor(normalizeBricks(team({ game: 'dota2', immunities: 2 })));

    expect(warnings.join(' ')).toMatch(/только в Genshin/);
  });

  it('про слишком много иммунов предупреждает', () => {
    const warnings = warningsFor(normalizeBricks(team({ game: 'genshin', entryMode: 'solo', immunities: 7 })));

    expect(warnings.join(' ')).toMatch(/банить почти нечего/);
  });
});
