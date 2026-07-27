import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

const valid = {
  DISCORD_TOKEN: 'token',
  DISCORD_APP_ID: '123456789012345678',
  DISCORD_GUILD_ID: '876543210987654321',
  DATABASE_URL: 'postgres://bot:bot@localhost:5432/disbot',
  REDIS_URL: 'redis://localhost:6379',
  PUBLIC_BASE_URL: 'https://bot.example.com',
};

describe('loadConfig', () => {
  it('заполняет значения по умолчанию', () => {
    const config = loadConfig(valid);
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.HTTP_PORT).toBe(3000);
  });

  it('приводит HTTP_PORT к числу', () => {
    const config = loadConfig({ ...valid, HTTP_PORT: '8080' });
    expect(config.HTTP_PORT).toBe(8080);
  });

  it('перечисляет в сообщении все отсутствующие параметры сразу', () => {
    let message = '';
    try {
      loadConfig({ DISCORD_TOKEN: 'token' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('DISCORD_APP_ID');
  });

  it('отвергает snowflake неверного формата', () => {
    expect(() => loadConfig({ ...valid, DISCORD_APP_ID: 'не-число' })).toThrow(/DISCORD_APP_ID/);
  });

  it('считает пустую строку необязательного ключа отсутствующим значением', () => {
    const config = loadConfig({ ...valid, RIOT_API_KEY: '' });
    expect(config.RIOT_API_KEY).toBeUndefined();
  });
});
