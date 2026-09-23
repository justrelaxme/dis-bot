import { describe, expect, it } from 'vitest';
import type { WelcomeSettingsRow } from '../../../src/modules/welcome/schema.js';
import { firstStep } from '../../../src/modules/welcome/texts.js';

const settings: WelcomeSettingsRow = {
  guildId: '111111111111111111',
  enabled: true,
  channelId: null,
  dmEnabled: true,
  autoRoleId: null,
  rulesChannelId: null,
  tournamentChannelId: null,
  greeting: null,
  updatedAt: new Date(0),
};

describe('первый шаг новичка', () => {
  it('без привязки называет команду для каждой дисциплины, Genshin в том числе', () => {
    const text = firstStep({ verifiedProviders: [], tournament: null, inRoster: false }, settings);

    for (const command of ['/link steam', '/link riot', '/link valorant', '/link genshin']) {
      expect(text).toContain(command);
    }
  });
});
