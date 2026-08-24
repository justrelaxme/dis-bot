import { probeDatabase, shortVersion, verdictOf } from '../src/core/db/probe.js';

/** Печать человеку, а не в лог бота: правило `no-console` в проекте стоит намеренно, а
 * `process.stderr.write` — тот же способ, которым говорит `scripts/test-services.mjs`. */
function say(line: string): void {
  process.stderr.write(`${line}
`);
}

/**
 * `npm run db:check` — проверить строку подключения, не трогая бота.
 *
 * Строку берём из аргумента или из DATABASE_URL. Аргумент нужен как раз при переезде: новую
 * базу проверяют, пока в окружении ещё стоит старая.
 *
 * Пароль в выводе не появляется ни при какой ошибке: команду запускают на своей машине, но
 * вывод люди пересылают, и строка подключения целиком уезжает вместе с ним.
 */

const url = process.argv[2] ?? process.env['DATABASE_URL'];

if (!url) {
  say('Укажите строку подключения: npm run db:check -- "postgres://..."');
  say('Либо задайте DATABASE_URL в окружении или .env.');
  process.exit(2);
}

/** Адрес без пароля: остальное в выводе не нужно, а пароль — тем более. */
function target(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    // Путь приходит закодированным: имя базы с не-латиницей иначе печатается в процентах.
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'не указана';
    return `${parsed.hostname}:${parsed.port || '5432'} база ${database} пользователь ${parsed.username || 'не указан'}`;
  } catch {
    return 'строку подключения не удалось разобрать как URL';
  }
}

say(`Проверяю: ${target(url)}`);

const probe = await probeDatabase(url);

if (!probe.ok) {
  say(`Не вышло: ${probe.message}`);
  // Сообщение самой ошибки — отдельной строкой: разбор говорит, что делать, а оно — что
  // именно ответила база.
  const detail = probe.error instanceof Error ? probe.error.message : String(probe.error);
  say(`Ответ базы: ${detail}`);
  process.exit(1);
}

say(`Подключился: ${shortVersion(probe.version)}, база ${probe.database}`);
say(
  probe.encrypted
    ? 'Соединение шифруется.'
    : 'Соединение НЕ шифруется. Для облачной базы это повод проверить sslmode в строке подключения.',
);
say(verdictOf(probe));
