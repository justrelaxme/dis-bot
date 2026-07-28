import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';

const TOKEN = 'СЕКРЕТ-ТОКЕН-БОТА';
const STEAM = 'СЕКРЕТ-STEAM';
const RIOT = 'СЕКРЕТ-RIOT';

const config = {
  LOG_LEVEL: 'info',
  // production, чтобы pino-pretty не встал между логгером и потоком.
  NODE_ENV: 'production',
  DISCORD_TOKEN: TOKEN,
  STEAM_API_KEY: STEAM,
  RIOT_API_KEY: RIOT,
} as unknown as Config;

function captured(): { write: (payload: object, msg: string) => string } {
  return {
    write(payload, msg) {
      let out = '';
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          out += String(chunk);
          callback();
        },
      });
      createLogger(config, stream).info(payload, msg);
      return out;
    },
  };
}

describe('createLogger: редакция секретов', () => {
  it('вырезает токен Discord и ключи API из объекта config', () => {
    const out = captured().write({ config }, 'запуск');

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(STEAM);
    expect(out).not.toContain(RIOT);
    expect(out).toContain('[вырезано]');
  });

  it('вырезает заголовки авторизации', () => {
    const out = captured().write(
      { headers: { authorization: 'Bearer СЕКРЕТ-AUTH', 'x-riot-token': 'СЕКРЕТ-XRIOT' } },
      'запрос',
    );

    expect(out).not.toContain('СЕКРЕТ-AUTH');
    expect(out).not.toContain('СЕКРЕТ-XRIOT');
  });

  it('сохраняет само сообщение и несекретные поля', () => {
    const out = captured().write({ guildId: '111111111111111111' }, 'команда выполнена');

    expect(out).toContain('команда выполнена');
    expect(out).toContain('111111111111111111');
  });

  it('контроль: путь вне списка redact не вырезается', () => {
    // Если этот тест начнёт падать, значит секреты скрывает что-то помимо redact,
    // и предыдущие три теста перестали доказывать то, ради чего написаны.
    const out = captured().write({ token: 'ЗНАЧЕНИЕ-ВНЕ-СПИСКА' }, 'контроль');

    expect(out).toContain('ЗНАЧЕНИЕ-ВНЕ-СПИСКА');
  });
});
