import { describe, expect, it } from 'vitest';
import { deliverBackup, type BackupChannel } from '../../../src/modules/maintenance/delivery.js';

/**
 * Доставка дампа. Главное правило — в открытый канал дамп не уходит никогда: это вся база,
 * включая привязки игровых аккаунтов.
 */

type Sent = { content: string; files?: Array<{ attachment: Buffer; name: string }> };

function channel(isPublic = false): BackupChannel & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    public: isPublic,
    sent,
    async send(payload) {
      sent.push(payload);
    },
  };
}

const dump = (bytes: number) => ({
  name: 'disbot-2026-09-23-0400.sql.gz',
  data: Buffer.alloc(bytes, 7),
  now: new Date('2026-09-23T04:00:00Z'),
});

describe('доставка бэкапа', () => {
  it('маленький дамп — одно сообщение с файлом и строкой восстановления', async () => {
    const target = channel();

    const result = await deliverBackup(target, dump(100), 1_000);

    expect(result).toEqual({ sent: true, parts: 1 });
    expect(target.sent).toHaveLength(1);
    expect(target.sent[0]?.files?.[0]?.name).toBe('disbot-2026-09-23-0400.sql.gz');
    expect(target.sent[0]?.content).toContain('gunzip -c disbot-2026-09-23-0400.sql.gz | psql');
  });

  /** Без ведущего нуля `cat *.part*` поставил бы десятую часть перед второй. */
  it('большой дамп — по части на сообщение, номера с ведущим нулём, склейка описана', async () => {
    const target = channel();

    const result = await deliverBackup(target, dump(2_500), 1_000);

    expect(result).toEqual({ sent: true, parts: 3 });
    expect(target.sent.map((message) => message.files?.[0]?.name)).toEqual([
      'disbot-2026-09-23-0400.sql.gz.part01',
      'disbot-2026-09-23-0400.sql.gz.part02',
      'disbot-2026-09-23-0400.sql.gz.part03',
    ]);
    expect(target.sent[0]?.content).toContain('cat disbot-2026-09-23-0400.sql.gz.part*');
    expect(target.sent.reduce((sum, message) => sum + (message.files?.[0]?.attachment.length ?? 0), 0)).toBe(2_500);
  });

  it('в канал, который видит @everyone, файл не уходит — уходит объяснение', async () => {
    const target = channel(true);

    const result = await deliverBackup(target, dump(100), 1_000);

    expect(result.sent).toBe(false);
    expect(target.sent).toHaveLength(1);
    expect(target.sent[0]?.files).toBeUndefined();
    expect(target.sent[0]?.content).toMatch(/@everyone/);
  });
});
