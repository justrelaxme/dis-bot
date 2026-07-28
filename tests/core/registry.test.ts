import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotModule } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';

function moduleWithCommand(moduleName: string, commandName: string): BotModule {
  return {
    name: moduleName,
    commands: [
      {
        builder: new SlashCommandBuilder().setName(commandName).setDescription('тест'),
        execute: async () => {},
      },
    ],
  };
}

describe('buildRegistry', () => {
  it('индексирует команды по имени', () => {
    const registry = buildRegistry([moduleWithCommand('alpha', 'one'), moduleWithCommand('beta', 'two')]);

    expect([...registry.commands.keys()].sort()).toEqual(['one', 'two']);
    expect(registry.commands.get('one')?.moduleName).toBe('alpha');
  });

  it('падает на двух модулях с одинаковым именем', () => {
    expect(() => buildRegistry([moduleWithCommand('alpha', 'one'), moduleWithCommand('alpha', 'two')])).toThrow(
      /alpha/,
    );
  });

  it('падает на двух модулях, объявивших одну команду', () => {
    expect(() => buildRegistry([moduleWithCommand('alpha', 'dup'), moduleWithCommand('beta', 'dup')])).toThrow(/dup/);
  });

  it('собирает джобы с указанием модуля-владельца', () => {
    const registry = buildRegistry([
      { name: 'alpha', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] },
    ]);

    expect(registry.jobs).toHaveLength(1);
    expect(registry.jobs[0]?.moduleName).toBe('alpha');
  });

  it('падает на двух модулях, объявивших одну джобу', () => {
    // croner держит собственный глобальный реестр имён и тоже бросит на дубликате,
    // но с указанием на croner, а не на виновные модули — поэтому проверка нужна здесь.
    const registry = () =>
      buildRegistry([
        { name: 'alpha', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] },
        { name: 'beta', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] },
      ]);

    expect(registry).toThrow(/sync/);
    expect(registry).toThrow(/alpha/);
    expect(registry).toThrow(/beta/);
  });

  it('принимает модуль без команд и джоб', () => {
    const registry = buildRegistry([{ name: 'пустой' }]);
    expect(registry.commands.size).toBe(0);
    expect(registry.modules).toHaveLength(1);
  });
});
