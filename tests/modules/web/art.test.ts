import { describe, expect, it } from 'vitest';
import { TOURNAMENT_GAMES } from '../../../src/modules/tournaments/games.js';
import {
  GAME_IDENTITY,
  SERVER_BAND,
  SERVER_CREDIT,
  VALORANT_AGENT_FACES,
  dotaHeroArt,
} from '../../../src/modules/web/art.js';

/**
 * Реестр арта — единственное место, где на витрине появляются ссылки на чужие CDN. Тесты
 * держат здесь три свойства: ссылка ведёт туда, куда обещано; у каждой дисциплины есть
 * опознавательные цвет и картинки; подпись об авторстве не потеряна.
 *
 * Что ссылки действительно открываются, тест проверить не может и не должен: это зависит от
 * сети, а не от кода, и падающий из-за чужого CDN набор тестов перестают читать. Проверено
 * руками по всему списку — путь `dota_react` есть у всех 127 героев, а старых вертикальных
 * портретов у Marci и Muerta нет, поэтому взят именно он.
 */

/** Хосты, которым позволено попадать на страницы: CDN самих игр и справочник Valorant. */
const ALLOWED_HOSTS = [
  'cdn.cloudflare.steamstatic.com',
  'media.valorant-api.com',
  'ddragon.leagueoflegends.com',
];

function hostsOf(urls: readonly string[]): string[] {
  return urls.map((url) => new URL(url).host);
}

describe('реестр игрового арта', () => {
  it('у каждой дисциплины есть акцент, полоса и подпись', () => {
    for (const game of TOURNAMENT_GAMES) {
      const identity = GAME_IDENTITY[game];

      expect(identity, `нет опознавательных знаков у ${game}`).toBeDefined();
      expect(identity.accent, `акцент ${game}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(identity.band.length, `полоса ${game}`).toBeGreaterThanOrEqual(3);
      expect(identity.credit.length, `подпись ${game}`).toBeGreaterThan(10);
    }
  });

  /**
   * Акценты обязаны различаться: вся затея с цветом дисциплины в том, чтобы страница Dota
   * не выглядела страницей Valorant. Два одинаковых значения делают её бессмысленной.
   */
  it('акценты дисциплин не повторяются', () => {
    const accents = TOURNAMENT_GAMES.map((game) => GAME_IDENTITY[game].accent);

    expect(new Set(accents).size).toBe(accents.length);
  });

  it('все картинки — с CDN игр и только по https', () => {
    const all = [
      ...TOURNAMENT_GAMES.flatMap((game) => GAME_IDENTITY[game].band),
      ...SERVER_BAND,
      ...VALORANT_AGENT_FACES,
      dotaHeroArt('pudge'),
    ];

    expect(all.every((url) => url.startsWith('https://')), 'нашлась ссылка не по https').toBe(true);
    for (const host of hostsOf(all)) expect(ALLOWED_HOSTS).toContain(host);
  });

  it('в полосе нет пустых ссылок', () => {
    const all = [...TOURNAMENT_GAMES.flatMap((game) => GAME_IDENTITY[game].band), ...SERVER_BAND];

    expect(all.filter((url) => url === '')).toEqual([]);
  });

  /**
   * Портрет героя берётся по пути `dota_react`, а не по старому `heroes/<slug>_vert.jpg`:
   * второго у героев, добавленных после 2021 года, Valve не публикует. Тест держит путь,
   * потому что переписать его «покороче» — ровно та правка, которая сломает четырёх героев
   * и не сломает ни одного теста.
   */
  it('портрет героя берётся по пути, который есть у всех героев', () => {
    expect(dotaHeroArt('marci')).toBe(
      'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/marci.png',
    );
    expect(dotaHeroArt('marci')).not.toContain('_vert');
  });

  /**
   * Полоса сервера смешана нарочно: главная страница и зал славы про сервер, а не про игру,
   * и одна дисциплина в шапке назначила бы главной ту, что просто оказалась первой в списке.
   */
  it('полоса сервера собрана из разных игр', () => {
    expect(new Set(hostsOf(SERVER_BAND)).size).toBeGreaterThan(1);
    expect(SERVER_CREDIT).toMatch(/Valve/);
    expect(SERVER_CREDIT).toMatch(/Riot/);
  });

  it('полоса Valorant показывает и карты, и агентов', () => {
    const band = GAME_IDENTITY.valorant.band;

    expect(band.some((url) => url.includes('/maps/')), 'нет карт').toBe(true);
    expect(band.some((url) => url.includes('/agents/')), 'нет агентов').toBe(true);
  });

  /**
   * У агентов берётся портрет из килл-фида (9 КБ), а не крупная иконка (400 КБ): агентов
   * двадцать девять, и на крупных иконках полотно весило бы одиннадцать мегабайт.
   */
  it('лица агентов — дешёвый портрет, а не крупная иконка', () => {
    expect(VALORANT_AGENT_FACES.every((url) => url.endsWith('killfeedportrait.png'))).toBe(true);
    expect(VALORANT_AGENT_FACES.some((url) => url.includes('displayicon'))).toBe(false);
  });
});
