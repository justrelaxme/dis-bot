import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  commandDuration: Histogram<'command' | 'outcome'>;
  providerErrors: Counter<'provider'>;
  render(): Promise<string>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const commandDuration = new Histogram({
    name: 'bot_command_duration_seconds',
    help: 'Длительность обработки slash-команд',
    labelNames: ['command', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 3, 10],
    registers: [registry],
  });

  const providerErrors = new Counter({
    name: 'bot_provider_errors_total',
    help: 'Сбои внешних игровых API',
    labelNames: ['provider'] as const,
    registers: [registry],
  });

  return {
    registry,
    commandDuration,
    providerErrors,
    render: () => registry.metrics(),
  };
}
