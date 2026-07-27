import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../src/core/metrics.js';

describe('createMetrics', () => {
  it('отдаёт длительность команд в формате Prometheus', async () => {
    const metrics = createMetrics();
    metrics.commandDuration.observe({ command: 'ping', outcome: 'ok' }, 0.012);

    const rendered = await metrics.render();

    expect(rendered).toContain('bot_command_duration_seconds');
    expect(rendered).toContain('command="ping"');
    expect(rendered).toContain('outcome="ok"');
  });

  it('считает ошибки провайдеров', async () => {
    const metrics = createMetrics();
    metrics.providerErrors.inc({ provider: 'riot-lol' });

    const rendered = await metrics.render();

    expect(rendered).toContain('bot_provider_errors_total');
    expect(rendered).toContain('provider="riot-lol"');
  });

  it('включает метрики процесса', async () => {
    const metrics = createMetrics();
    const rendered = await metrics.render();
    expect(rendered).toContain('process_cpu_user_seconds_total');
  });
});
