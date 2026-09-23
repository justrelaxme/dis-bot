import { describe, expect, it } from 'vitest';
import { explainBackupFailure, planParts, splitPassword } from '../../src/core/backup.js';

describe('нарезка дампа на вложения', () => {
  it('маленький дамп — одна часть целиком', () => {
    expect(planParts(300, 1_000)).toEqual([[0, 300]]);
  });

  it('ровно по пределу — всё ещё одна часть', () => {
    expect(planParts(1_000, 1_000)).toEqual([[0, 1_000]]);
  });

  /** Части склеиваются `cat` по порядку, поэтому границы идут встык, без дыр и перекрытий. */
  it('большой дамп режется встык до последнего байта', () => {
    const parts = planParts(2_500, 1_000);

    expect(parts).toEqual([
      [0, 1_000],
      [1_000, 2_000],
      [2_000, 2_500],
    ]);
  });

  it('пустой дамп — нечего резать', () => {
    expect(planParts(0, 1_000)).toEqual([]);
  });

  it('по умолчанию предел ниже 10 МиБ — лимита Discord без бустов', () => {
    const [first] = planParts(50 * 1_048_576);
    expect(first?.[1]).toBeLessThan(10 * 1_048_576);
  });
});

/** Адрес идёт аргументом `pg_dump` и виден в списке процессов, пароль — нет. */
describe('пароль отдельно от адреса', () => {
  it('вынимает пароль и раскодирует его', () => {
    const split = splitPassword('postgresql://postgres.ref:%D0%BE%D0%B3%22@pooler.example.com:5432/postgres?sslmode=verify-full');

    expect(split.password).toBe('ог"');
    expect(split.url).toBe('postgresql://postgres.ref@pooler.example.com:5432/postgres?sslmode=verify-full');
  });

  it('без пароля адрес не трогает', () => {
    expect(splitPassword('postgres://bot@localhost/db')).toEqual({ url: 'postgres://bot@localhost/db', password: null });
  });

  it('неразборчивый адрес отдаёт как есть — пусть pg_dump скажет, что не так', () => {
    expect(splitPassword('не адрес')).toEqual({ url: 'не адрес', password: null });
  });
});

describe('отказ бэкапа словами', () => {
  const failure = (message: string, code?: string): Error => Object.assign(new Error(message), code ? { code } : {});

  it('нет pg_dump', () => {
    expect(explainBackupFailure(failure('spawn pg_dump ENOENT', 'ENOENT'))).toMatch(/нет `pg_dump`/);
  });

  it('нет прав на каталог', () => {
    expect(explainBackupFailure(failure("EACCES: permission denied, mkdir './backups'", 'EACCES'))).toMatch(/BACKUP_DIR/);
  });

  it('pg_dump старше сервера', () => {
    expect(
      explainBackupFailure(failure('pg_dump завершился с кодом 1: pg_dump: error: aborting because of server version mismatch')),
    ).toMatch(/старше версии сервера/);
  });

  it('неверный пароль', () => {
    expect(explainBackupFailure(failure('password authentication failed for user "postgres"'))).toMatch(/пароль/);
  });

  it('незнакомое — как есть, но не простынёй', () => {
    const text = explainBackupFailure(failure('x'.repeat(2_000)));
    expect(text.length).toBeLessThanOrEqual(500);
  });
});
