// Shared auth for generic connectors: none | header | bearer | basic | query | oauth2 client credentials.
import type { JSONSchema } from '../../shared/types';
import { basicAuth, httpFetch } from '../http';
import { S } from './types';

export const AUTH_SCHEMA: Record<string, JSONSchema> = {
  authType: S.oneOf('Authentication', ['none', 'query', 'header', 'bearer', 'basic', 'oauth2_client_credentials'], 'none', {
    description: "query: use {apiKey} in the URL template. header: sent as <Header name>: <API key>.",
  }),
  apiKey: S.secret('API key / token'),
  authHeaderName: S.str('Header name (header auth)', { default: 'X-API-Key' }),
  username: S.str('Username (basic auth)'),
  password: S.secret('Password (basic auth)'),
  tokenUrl: S.url('OAuth2 token URL'),
  clientId: S.str('OAuth2 client ID'),
  clientSecret: S.secret('OAuth2 client secret'),
  scope: S.str('OAuth2 scope'),
  extraHeaders: S.json('Extra headers (JSON object)', '{}'),
};

const tokenCache = new Map<string, { token: string; exp: number }>();

export async function authHeaders(config: Record<string, any>, cacheKey: string): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  try {
    Object.assign(h, JSON.parse(config.extraHeaders || '{}'));
  } catch {
    throw new Error('Extra headers is not valid JSON');
  }
  switch (config.authType ?? 'none') {
    case 'header': h[config.authHeaderName || 'X-API-Key'] = config.apiKey ?? ''; break;
    case 'bearer': h.Authorization = `Bearer ${config.apiKey ?? ''}`; break;
    case 'basic': h.Authorization = basicAuth(config.username ?? '', config.password ?? ''); break;
    case 'oauth2_client_credentials': {
      const hit = tokenCache.get(cacheKey);
      if (hit && hit.exp > Date.now() + 30_000) { h.Authorization = `Bearer ${hit.token}`; break; }
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId ?? '', client_secret: config.clientSecret ?? '' });
      if (config.scope) body.set('scope', config.scope);
      const res = await httpFetch(config.tokenUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
      const j = (await res.json()) as { access_token: string; expires_in?: number };
      tokenCache.set(cacheKey, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
      h.Authorization = `Bearer ${j.access_token}`;
      break;
    }
  }
  return h;
}
