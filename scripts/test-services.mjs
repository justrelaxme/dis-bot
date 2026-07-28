#!/usr/bin/env node
// Поднимает и гасит Postgres и Redis для интеграционных тестов.
// Своим скриптом, а не compose: podman compose требует внешнего провайдера
// (docker-compose или podman-compose), а здесь всего два контейнера без сети между ними.
import { spawnSync } from 'node:child_process';

const SERVICES = [
  {
    name: 'disbot-test-pg',
    image: 'postgres:16-alpine',
    args: [
      '-e', 'POSTGRES_USER=bot',
      '-e', 'POSTGRES_PASSWORD=bot',
      '-e', 'POSTGRES_DB=disbot_test',
      '-p', '55432:5432',
    ],
    ready: ['pg_isready', '-U', 'bot', '-d', 'disbot_test'],
  },
  {
    name: 'disbot-test-redis',
    image: 'redis:7-alpine',
    args: ['-p', '56379:6379'],
    ready: ['redis-cli', 'ping'],
  },
];

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

function podman(args) {
  return spawnSync('podman', args, { encoding: 'utf8' });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function exists(name) {
  return podman(['container', 'exists', name]).status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(service) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (podman(['exec', service.name, ...service.ready]).status === 0) return;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`Сервис ${service.name} не стал готов за ${READY_TIMEOUT_MS / 1000}с. Логи: podman logs ${service.name}`);
}

async function up() {
  if (podman(['info', '--format', '{{.Host.Arch}}']).status !== 0) {
    fail('Podman недоступен. Запусти машину: podman machine start');
  }

  for (const service of SERVICES) {
    if (exists(service.name)) {
      podman(['start', service.name]);
    } else {
      const created = podman(['run', '-d', '--name', service.name, ...service.args, service.image]);
      if (created.status !== 0) fail(`Не удалось создать ${service.name}: ${created.stderr.trim()}`);
    }
    await waitReady(service);
    process.stderr.write(`готов: ${service.name}\n`);
  }
}

function down() {
  for (const service of SERVICES) {
    podman(['rm', '-f', service.name]);
    process.stderr.write(`удалён: ${service.name}\n`);
  }
}

const command = process.argv[2];
if (command === 'up') await up();
else if (command === 'down') down();
else fail('Использование: node scripts/test-services.mjs up|down');
