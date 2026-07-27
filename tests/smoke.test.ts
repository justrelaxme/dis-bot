import { describe, expect, it } from 'vitest';
import { projectName } from '../src/core/meta.js';

describe('каркас проекта', () => {
  it('экспортирует имя проекта', () => {
    expect(projectName).toBe('dis-bot');
  });
});
