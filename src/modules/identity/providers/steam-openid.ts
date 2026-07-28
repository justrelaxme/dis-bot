import { ProviderError } from '../../../core/errors.js';

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';

export function buildSteamLoginUrl(opts: { returnTo: string; realm: string }): string {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': opts.returnTo,
    'openid.realm': opts.realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

export function extractSteamId(claimedId: string): string | null {
  if (!claimedId.startsWith(CLAIMED_ID_PREFIX)) return null;
  const id = claimedId.slice(CLAIMED_ID_PREFIX.length);
  return /^\d{17}$/.test(id) ? id : null;
}

/**
 * Проверяет подлинность возврата, переспрашивая Steam через check_authentication.
 * Доверять параметрам запроса нельзя: их подделает любой, кто знает адрес колбэка.
 */
export async function verifySteamAssertion(
  params: URLSearchParams,
  deps: { fetch?: typeof fetch },
): Promise<string> {
  const mode = params.get('openid.mode');
  if (mode !== 'id_res') {
    throw new ProviderError(`авторизация отменена или прервана (mode=${mode ?? 'отсутствует'})`, 'steam');
  }

  const claimedId = params.get('openid.claimed_id') ?? '';
  const steamId = extractSteamId(claimedId);
  if (!steamId) {
    throw new ProviderError(`claimed_id не принадлежит Steam: ${claimedId}`, 'steam');
  }

  const verification = new URLSearchParams(params);
  verification.set('openid.mode', 'check_authentication');

  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: verification,
  });

  const text = await response.text();
  if (!/^is_valid:true$/m.test(text.trim())) {
    throw new ProviderError('Steam не подтвердил подпись возврата', 'steam');
  }

  return steamId;
}
