import { describe, expect, it } from 'vitest';
import { BugError, ProviderError, UserError, describeForUser, newIncidentId } from '../../src/core/errors.js';

describe('newIncidentId', () => {
  it('возвращает шесть шестнадцатеричных символов', () => {
    expect(newIncidentId()).toMatch(/^[0-9a-f]{6}$/);
  });

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newIncidentId()));
    expect(ids.size).toBeGreaterThan(190);
  });
});

describe('describeForUser', () => {
  it('показывает текст UserError как есть и не выдаёт код инцидента', () => {
    const result = describeForUser(new UserError('Такой аккаунт уже привязан.'));
    expect(result.text).toBe('Такой аккаунт уже привязан.');
    expect(result.incidentId).toBeUndefined();
  });

  it('называет провайдера при ProviderError, но не раскрывает детали', () => {
    const result = describeForUser(new ProviderError('502 Bad Gateway', 'riot-lol'));
    expect(result.text).toContain('riot-lol');
    expect(result.text).not.toContain('502');
    expect(result.incidentId).toBeUndefined();
  });

  it('выдаёт код инцидента для BugError', () => {
    const result = describeForUser(new BugError('обращение к null'));
    expect(result.incidentId).toMatch(/^[0-9a-f]{6}$/);
    expect(result.text).toContain(result.incidentId!);
    expect(result.text).not.toContain('обращение к null');
  });

  it('обрабатывает произвольное брошенное значение как баг', () => {
    const result = describeForUser('строка вместо ошибки');
    expect(result.incidentId).toMatch(/^[0-9a-f]{6}$/);
  });
});
