import { describe, expect, it } from 'vitest';
import {
  formatCardsHtml,
  formatsDenied,
  formatsShell,
  type FormatCard,
  type FormatsShellState,
} from '../../../src/modules/web/formats-page.js';

/**
 * Страница конструктора. Проверяется не вид — его тест не увидит, — а то, от чего зависит
 * работоспособность: на каждый кирпичик есть управление, чужой текст экранирован, а
 * начальные данные не могут закрыть тег и превратиться в разметку.
 */

const state = (over: Partial<FormatsShellState> = {}): FormatsShellState => ({
  token: 'tok-1',
  guildName: 'Сервер',
  games: [
    { value: 'dota2', label: 'Dota 2' },
    { value: 'valorant', label: 'Valorant' },
  ],
  cards: [],
  limit: 25,
  ...over,
});

const card = (over: Partial<FormatCard> = {}): FormatCard => ({
  id: 7,
  name: 'Вечерний',
  summary: 'Dota 2 · турнир на 16 составов по 5',
  note: null,
  usedCount: 3,
  game: 'dota2',
  bricks: { game: 'dota2', entryMode: 'team', teamSize: 5 },
  ...over,
});

describe('конструктор форматов', () => {
  it('на каждый кирпичик есть управление', () => {
    const html = formatsShell(state());

    for (const key of ['game', 'entryMode', 'format', 'bestOf', 'seeding']) {
      expect(html, `нет выбора для ${key}`).toContain(`data-k="${key}"`);
    }
    for (const key of ['teamSize', 'maxEntrants', 'registrationHours']) {
      expect(html, `нет поля для ${key}`).toContain(`data-n="${key}"`);
    }
    for (const key of ['abilities', 'autoTeams', 'requireVerified']) {
      expect(html, `нет переключателя для ${key}`).toContain(`data-t="${key}"`);
    }
  });

  /** «Любая дисциплина» — законный выбор: формат бывает про форму вечера, а не про игру. */
  it('среди дисциплин есть «Любая» пустым значением', () => {
    const html = formatsShell(state());

    expect(html).toContain('data-k="game" data-v=""');
    expect(html).toContain('data-k="game" data-v="dota2"');
  });

  it('имя формата и заметка — поля ввода с ограничением длины', () => {
    const html = formatsShell(state());

    expect(html).toContain('id="fname"');
    expect(html).toContain('maxlength="60"');
    expect(html).toContain('id="fnote"');
    expect(html).toContain('maxlength="200"');
  });

  it('предпросмотр и кнопка сохранения на месте', () => {
    const html = formatsShell(state());

    expect(html).toContain('id="phead"');
    expect(html).toContain('id="save"');
  });

  it('в карточке видно, чем формат запускают', () => {
    const html = formatCardsHtml([card()]);

    expect(html).toContain('/tournament create preset:Вечерний');
    expect(html).toContain('запусков 3');
  });

  /** Ради этого формат и собирают: воспользоваться им, не переключаясь в Discord. */
  it('на карточке есть кнопка запуска', () => {
    expect(formatCardsHtml([card()])).toContain('data-run="7"');
  });

  /**
   * У формата без дисциплины её спрашивают в самой карточке. Без неё бот не знает ни про
   * драфт, ни про жеребьёвку, и отказ пришёл бы уже после подтверждения запуска.
   */
  it('формат без дисциплины предлагает выбрать её при запуске', () => {
    const games = [
      { value: 'dota2', label: 'Dota 2' },
      { value: 'genshin', label: 'Genshin Impact' },
    ];
    const html = formatCardsHtml([card({ game: null })], games);

    expect(html).toContain('data-game=""');
    expect(html).toContain('data-go="7" data-game="dota2"');
    expect(html).toContain('data-go="7" data-game="genshin"');
  });

  it('у формата с дисциплиной выбора нет: он лишний', () => {
    const html = formatCardsHtml([card({ game: 'dota2' })], [{ value: 'dota2', label: 'Dota 2' }]);

    expect(html).toContain('data-game="dota2"');
    expect(html).not.toContain('data-go=');
  });

  it('ни разу не запущенный формат так и подписан, а не «запусков 0»', () => {
    expect(formatCardsHtml([card({ usedCount: 0 })])).toContain('ещё не запускали');
  });

  /** Имя формата пишет человек, и в нём может оказаться что угодно. */
  it('имя формата экранируется', () => {
    const html = formatCardsHtml([card({ name: '<img src=x onerror=alert(1)>' })]);

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('заметка экранируется', () => {
    const html = formatCardsHtml([card({ note: '</p><script>bad()</script>' })]);

    expect(html).not.toContain('<script>bad()');
  });

  /**
   * Начальные данные встраиваются в страницу. Строка вида `</script>` внутри имени иначе
   * закрыла бы тег и превратила данные в разметку — это и есть способ подменить страницу.
   */
  it('начальные данные не могут закрыть тег', () => {
    const html = formatsShell(state({ cards: [card({ name: '</script><script>bad()</script>' })] }));

    expect(html).not.toContain('</script><script>bad()');
    expect(html).toContain('window.__FORMATS__');
  });

  it('пустой список подписан, а не оставлен пустым местом', () => {
    expect(formatCardsHtml([])).toContain('Пока ни одного');
  });

  it('счётчик показывает предел, а не только текущее число', () => {
    const html = formatsShell(state({ cards: [card()], limit: 25 }));

    expect(html).toContain('1 из 25');
  });
});

describe('недействующая ссылка', () => {
  /** Отказ надо объяснить: 404 на месте живой страницы читается как поломка бота. */
  it('говорит, какой командой просить новую', () => {
    const html = formatsDenied();

    expect(html).toContain('/tournament formats');
    expect(html).toContain('сутки');
  });
});
