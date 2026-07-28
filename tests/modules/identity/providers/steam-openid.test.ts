import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../../../src/core/errors.js';
import {
  buildSteamLoginUrl,
  extractSteamId,
  verifySteamAssertion,
} from '../../../../src/modules/identity/providers/steam-openid.js';

describe('buildSteamLoginUrl', () => {
  it('строит адрес входа со всеми обязательными параметрами OpenID 2.0', () => {
    const url = new URL(
      buildSteamLoginUrl({ returnTo: 'https://bot.example.com/steam/callback', realm: 'https://bot.example.com' }),
    );

    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
    expect(url.searchParams.get('openid.identity')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
    expect(url.searchParams.get('openid.claimed_id')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
    expect(url.searchParams.get('openid.return_to')).toBe('https://bot.example.com/steam/callback');
    expect(url.searchParams.get('openid.realm')).toBe('https://bot.example.com');
  });
});

describe('extractSteamId', () => {
  it('вынимает SteamID64 из claimed_id', () => {
    expect(extractSteamId('https://steamcommunity.com/openid/id/76561198000000001')).toBe('76561198000000001');
  });

  it('возвращает null на чужом домене', () => {
    expect(extractSteamId('https://evil.example.com/openid/id/76561198000000001')).toBeNull();
  });

  it('возвращает null, если идентификатор не похож на SteamID64', () => {
    expect(extractSteamId('https://steamcommunity.com/openid/id/не-число')).toBeNull();
  });

  it('возвращает null для чужого домена, подогнанного по длине под Steam', () => {
    // Префикс Steam — ровно 37 символов, столько же в этом адресе. Без проверки домена
    // slice() отрезал бы ровно 17 цифр и подделка прошла бы как настоящий SteamID64.
    expect(extractSteamId('https://notsteamcommun.com/openid/id/76561198000000001')).toBeNull();
  });

  it('возвращает null для верного домена с чужим путём', () => {
    expect(extractSteamId('https://steamcommunity.com/openid/ID/76561198000000001')).toBeNull();
  });
});

describe('verifySteamAssertion', () => {
  const validParams = () =>
    new URLSearchParams({
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
      'openid.signed': 'signed,op_endpoint,claimed_id',
      'openid.sig': 'подпись',
    });

  it('возвращает SteamID64, когда Steam подтвердил подпись', async () => {
    const fetchMock = vi.fn(async () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    await expect(verifySteamAssertion(validParams(), { fetch: fetchMock as unknown as typeof fetch })).resolves.toBe(
      '76561198000000001',
    );
  });

  it('отправляет check_authentication, а не доверяет параметрам', async () => {
    const fetchMock = vi.fn(async () => new Response('is_valid:true\n'));
    await verifySteamAssertion(validParams(), { fetch: fetchMock as unknown as typeof fetch });

    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    if (!call || call.length < 2) throw new Error('fetchMock не был вызван');
    const requestInit = call[1] as unknown as Record<string, unknown>;
    const body = new URLSearchParams(requestInit.body as string);
    expect(body.get('openid.mode')).toBe('check_authentication');
  });

  it('отвергает, когда Steam ответил is_valid:false', async () => {
    const fetchMock = vi.fn(async () => new Response('is_valid:false\n'));
    await expect(
      verifySteamAssertion(validParams(), { fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(ProviderError);
  });

  it('отвергает возврат с неверным openid.mode', async () => {
    const params = validParams();
    params.set('openid.mode', 'cancel');
    await expect(verifySteamAssertion(params, {})).rejects.toThrow(/отменена/);
  });

  it('отвергает claimed_id с чужого домена, не обращаясь к сети', async () => {
    const params = validParams();
    params.set('openid.claimed_id', 'https://evil.example.com/openid/id/76561198000000001');
    const fetchMock = vi.fn();

    await expect(verifySteamAssertion(params, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      ProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('не ходит в сеть и на чужом домене, подогнанном по длине под Steam', async () => {
    const params = validParams();
    params.set('openid.claimed_id', 'https://notsteamcommun.com/openid/id/76561198000000001');
    const fetchMock = vi.fn();

    await expect(verifySteamAssertion(params, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      ProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
