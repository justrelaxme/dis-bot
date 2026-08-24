import { describe, expect, it } from 'vitest';
import { UserError } from '../../../src/core/errors.js';
import { createFormatsService } from '../../../src/modules/tournaments/services/formats.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Сохранённые форматы против настоящего Postgres: главное свойство здесь — уникальность
 * «сервер плюс имя», а она стоит ограничением в базе, а не проверкой перед записью. На
 * заглушке это не проверяется вообще.
 */

let counter = 0;
const guild = (): string => {
  counter += 1;
  return `71000000000000${String(counter).padStart(4, '0')}`;
};

const bricks = {
  game: 'dota2' as const,
  entryMode: 'team' as const,
  teamSize: 5,
  maxEntrants: 16,
  format: 'single-elim' as const,
  bestOf: 1,
};

describe('сохранение формата', () => {
  it('сохраняет и находит по имени', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    const saved = await formats.save({ guildId, name: 'Вечерний', createdBy: 'org', bricks });

    expect(saved.created).toBe(true);
    expect(saved.row.name).toBe('Вечерний');
    expect((await formats.byName(guildId, 'Вечерний'))?.id).toBe(saved.row.id);
  });

  /**
   * Второе сохранение под тем же именем — правка, а не двойник. Организатор, сохраняющий
   * «Вечерний» второй раз, хочет поменять «Вечерний», а не завести «Вечерний (2)», в котором
   * через месяц не разберётся никто.
   */
  it('то же имя правит формат, а не заводит второй', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    const first = await formats.save({ guildId, name: 'Вечерний', createdBy: 'org', bricks });
    const second = await formats.save({
      guildId,
      name: 'Вечерний',
      createdBy: 'другой',
      bricks: { ...bricks, maxEntrants: 8, bestOf: 3 },
    });

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.maxEntrants).toBe(8);
    expect(second.row.bestOf).toBe(3);
    expect(await formats.count(guildId)).toBe(1);
  });

  /** Правка не переписывает, кто формат придумал, и не отменяет того, что по нему играли. */
  it('правка сохраняет автора и счётчик запусков', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    const first = await formats.save({ guildId, name: 'Вечерний', createdBy: 'первый', bricks });
    await formats.markUsed(first.row.id);
    await formats.markUsed(first.row.id);

    const edited = await formats.save({
      guildId,
      name: 'Вечерний',
      createdBy: 'второй',
      bricks: { ...bricks, teamSize: 2 },
    });

    expect(edited.row.createdBy).toBe('первый');
    expect(edited.row.usedCount).toBe(2);
    expect(edited.row.teamSize).toBe(2);
  });

  it('имя обрезается по краям: «Вечерний » и «Вечерний» — один формат', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    await formats.save({ guildId, name: 'Вечерний', createdBy: 'org', bricks });
    await formats.save({ guildId, name: '  Вечерний  ', createdBy: 'org', bricks });

    expect(await formats.count(guildId)).toBe(1);
  });

  it('без имени не сохраняется', async () => {
    const formats = createFormatsService({ db: pg.db });

    await expect(formats.save({ guildId: guild(), name: '   ', createdBy: 'org', bricks })).rejects.toThrow(
      UserError,
    );
  });

  /** Форматы разных серверов не видят друг друга: одно имя на двух серверах — законно. */
  it('одно имя на двух серверах — два разных формата', async () => {
    const formats = createFormatsService({ db: pg.db });
    const first = guild();
    const second = guild();

    await formats.save({ guildId: first, name: 'Вечерний', createdBy: 'org', bricks });
    await formats.save({ guildId: second, name: 'Вечерний', createdBy: 'org', bricks });

    expect(await formats.count(first)).toBe(1);
    expect(await formats.count(second)).toBe(1);
  });

  it('противоречивый набор не доходит до базы', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    await expect(
      formats.save({
        guildId,
        name: 'Кривой',
        createdBy: 'org',
        bricks: { ...bricks, entryMode: 'solo', autoTeams: true },
      }),
    ).rejects.toThrow(UserError);
    expect(await formats.count(guildId)).toBe(0);
  });
});

describe('список форматов', () => {
  /**
   * Сверху то, чем правда пользуются. Иначе первым в списке навсегда остаётся формат,
   * который назвали раньше остальных, — и выбирать приходится, читая весь список.
   */
  it('сортируется по числу запусков', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    const rare = await formats.save({ guildId, name: 'Редкий', createdBy: 'org', bricks });
    const often = await formats.save({ guildId, name: 'Частый', createdBy: 'org', bricks });
    await formats.markUsed(often.row.id);
    await formats.markUsed(often.row.id);
    await formats.markUsed(rare.row.id);

    const list = await formats.list(guildId);

    expect(list.map((row) => row.name)).toEqual(['Частый', 'Редкий']);
  });

  it('запуск отмечается временем, а не только счётчиком', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();

    const saved = await formats.save({ guildId, name: 'Вечерний', createdBy: 'org', bricks });
    expect(saved.row.lastUsedAt).toBeNull();

    await formats.markUsed(saved.row.id);

    expect((await formats.byName(guildId, 'Вечерний'))?.lastUsedAt).not.toBeNull();
  });
});

describe('правка и удаление', () => {
  it('переименование меняет имя', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();
    const saved = await formats.save({ guildId, name: 'Старое', createdBy: 'org', bricks });

    await formats.rename(guildId, saved.row.id, 'Новое');

    expect(await formats.byName(guildId, 'Старое')).toBeNull();
    expect((await formats.byName(guildId, 'Новое'))?.id).toBe(saved.row.id);
  });

  /** Переименовать в занятое имя значило бы потерять один из двух форматов молча. */
  it('переименование в занятое имя — отказ', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();
    const first = await formats.save({ guildId, name: 'Первый', createdBy: 'org', bricks });
    await formats.save({ guildId, name: 'Второй', createdBy: 'org', bricks });

    await expect(formats.rename(guildId, first.row.id, 'Второй')).rejects.toThrow(UserError);
    expect(await formats.count(guildId)).toBe(2);
  });

  it('переименование в то же имя проходит: это не столкновение с самим собой', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();
    const saved = await formats.save({ guildId, name: 'Вечерний', createdBy: 'org', bricks });

    await expect(formats.rename(guildId, saved.row.id, 'Вечерний')).resolves.toMatchObject({
      id: saved.row.id,
    });
  });

  it('удаление убирает формат', async () => {
    const formats = createFormatsService({ db: pg.db });
    const guildId = guild();
    const saved = await formats.save({ guildId, name: 'Лишний', createdBy: 'org', bricks });

    const removed = await formats.remove(guildId, saved.row.id);

    expect(removed.name).toBe('Лишний');
    expect(await formats.count(guildId)).toBe(0);
  });

  /**
   * Идентификатор приходит из браузера, и доверять ему нельзя: без фильтра по серверу
   * пропуск на своём сервере позволял бы удалить формат чужого.
   */
  it('чужой формат не удаляется и не читается по идентификатору', async () => {
    const formats = createFormatsService({ db: pg.db });
    const mine = guild();
    const other = guild();
    const theirs = await formats.save({ guildId: other, name: 'Чужой', createdBy: 'org', bricks });

    await expect(formats.remove(mine, theirs.row.id)).rejects.toThrow(UserError);
    expect(await formats.byId(mine, theirs.row.id)).toBeNull();
    expect(await formats.count(other)).toBe(1);
  });

  it('чужой формат не переименовывается', async () => {
    const formats = createFormatsService({ db: pg.db });
    const mine = guild();
    const other = guild();
    const theirs = await formats.save({ guildId: other, name: 'Чужой', createdBy: 'org', bricks });

    await expect(formats.rename(mine, theirs.row.id, 'Мой')).rejects.toThrow(UserError);
    expect((await formats.byName(other, 'Чужой'))?.id).toBe(theirs.row.id);
  });
});
