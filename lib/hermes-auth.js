/**
 * Hermes Agent login reuse (Nous Portal OAuth).
 *
 * Hermes stores the Nous OAuth session in `$HERMES_HOME/auth.json`. The access
 * token is short-lived (about one hour). While the Hermes gateway runs it is
 * the only refresher; when it is not running this bridge refreshes the token
 * through the same Portal endpoint and writes the rotated tokens back so the
 * Hermes install keeps working.
 *
 * Single-use refresh tokens mean refresh must never race Hermes: callers pass
 * `gatewayAlive` and skip refresh when the gateway is up.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hermesHomeDefault } from './discovery.js';

const REFRESH_MARGIN_MS = 90_000;
const DEFAULT_INFERENCE_BASE = 'https://inference-api.nousresearch.com/v1';
const DEFAULT_PORTAL_BASE = 'https://portal.nousresearch.com';

function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

export function decodeJwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 插件启动时写入的已发现 Hermes 数据根。 */
let discoveredHome = null;

export function setDiscoveredHermesHome(path) {
  if (typeof path === 'string' && path.length > 0) discoveredHome = path;
}

export function hermesHomeFromEnv(options = {}) {
  if (typeof options.home === 'string' && options.home.length > 0) return options.home;
  if (typeof process.env.HERMES_HOME === 'string' && process.env.HERMES_HOME.length > 0) return process.env.HERMES_HOME;
  if (discoveredHome) return discoveredHome;
  try {
    return hermesHomeDefault() ?? 'C:\\AI_Workspace\\01_Agents\\HermesAgent\\home';
  } catch {
    return 'C:\\AI_Workspace\\01_Agents\\HermesAgent\\home';
  }
}

async function readAuthFile(home) {
  const path = join(home, 'auth.json');
  const text = await readFile(path, 'utf8');
  return { path, raw: parseJson(text) };
}

function nousStateOf(raw) {
  return raw && raw.providers && raw.providers.nous ? raw.providers.nous : null;
}

function expiryOf(state) {
  const iso = state && typeof state.expires_at === 'string' ? Date.parse(state.expires_at) : NaN;
  if (Number.isFinite(iso)) return iso;
  const claims = state ? decodeJwtClaims(state.access_token) : null;
  if (claims && Number.isFinite(claims.exp)) return claims.exp * 1000;
  return 0;
}

/** True when a gateway process recorded in `gateway_state.json` is still alive. */
export async function gatewayLooksAlive(home) {
  try {
    const state = parseJson(await readFile(join(home, 'gateway_state.json'), 'utf8'));
    const pid = Number(state && state.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function persistRotatedState(path, raw, refreshed) {
  const next = {
    ...raw,
    providers: {
      ...(raw.providers ?? {}),
      nous: {
        ...(raw.providers?.nous ?? {}),
        ...refreshed,
      },
    },
    updated_at: new Date().toISOString(),
  };
  const tmp = `${path}.${process.pid}.dsh-agent-llm.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

let refreshInFlight = null;

async function refreshNousToken(home, state) {
  const portalBase = (state.portal_base_url || DEFAULT_PORTAL_BASE).replace(/\/+$/, '');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: typeof state.client_id === 'string' && state.client_id.length > 0 ? state.client_id : 'hermes-cli',
  });
  const response = await fetch(`${portalBase}/api/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-nous-refresh-token': state.refresh_token,
    },
    body,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = parseJson(text);
  } catch {
    /* non-JSON edge page */
  }
  if (!response.ok) {
    const mitigated = response.headers.get('x-vercel-mitigated');
    const code = payload && payload.error;
    const message = mitigated
      ? `Nous Portal 边缘防护暂时拒绝刷新（HTTP ${response.status}，${mitigated}）；凭据保留，请稍后重试。`
      : `Nous Portal 刷新登录失败（HTTP ${response.status}${code ? `，${code}` : ''}）${
          payload && payload.error_description ? `：${payload.error_description}` : ''
        }`;
    const error = new Error(message);
    error.code = response.status === 429 ? 'RATE_LIMIT' : 'AUTH';
    error.status = response.status;
    throw error;
  }
  if (!payload || typeof payload.access_token !== 'string') {
    const error = new Error('Nous Portal 刷新响应缺少 access_token');
    error.code = 'AUTH';
    throw error;
  }
  const ttl = Number(payload.expires_in);
  const now = Date.now();
  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0 ? payload.refresh_token : state.refresh_token,
    token_type: payload.token_type || state.token_type || 'Bearer',
    scope: payload.scope || state.scope,
    obtained_at: new Date(now).toISOString(),
    expires_in: Number.isFinite(ttl) ? Math.trunc(ttl) : 3600,
    expires_at: new Date(now + (Number.isFinite(ttl) ? ttl : 3600) * 1000).toISOString(),
  };
}

/**
 * Resolve a usable Nous inference session.
 * @param {{home?: string, allowRefresh?: boolean, log?: object}} [options]
 */
export async function resolveHermesSession(options = {}) {
  const home = hermesHomeFromEnv(options);
  const { path, raw } = await readAuthFile(home);
  let state = nousStateOf(raw);
  if (!state || typeof state.access_token !== 'string') {
    const error = new Error('Hermes 尚未登录 Nous 账号：请先运行一次 Hermes 并完成登录。');
    error.code = 'AUTH';
    throw error;
  }
  let expiresAt = expiryOf(state);
  const claims = decodeJwtClaims(state.access_token) ?? {};
  const inferenceBase = (
    typeof state.inference_base_url === 'string' && state.inference_base_url.length > 0
      ? state.inference_base_url
      : claims.inference_base_url || DEFAULT_INFERENCE_BASE
  ).replace(/\/+$/, '');

  if (expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return { home, path, raw, state, token: state.access_token, inferenceBase, claims, refreshed: false };
  }

  if (options.allowRefresh === false) {
    const error = new Error('Hermes 的 Nous 登录已过期，且当前配置禁止自动续期。');
    error.code = 'AUTH';
    throw error;
  }

  /* Prefer letting Hermes refresh while its gateway is running. */
  if (await gatewayLooksAlive(home)) {
    const reread = await readAuthFile(home);
    const fresh = nousStateOf(reread.raw);
    if (fresh && expiryOf(fresh) - REFRESH_MARGIN_MS > Date.now()) {
      return {
        home,
        path: reread.path,
        raw: reread.raw,
        state: fresh,
        token: fresh.access_token,
        inferenceBase,
        claims: decodeJwtClaims(fresh.access_token) ?? claims,
        refreshed: false,
      };
    }
    const error = new Error('Hermes 网关正在运行但登录尚未刷新，请稍后重试，或在 Hermes 中重新登录。');
    error.code = 'AUTH';
    throw error;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const current = await readAuthFile(home);
      const currentState = nousStateOf(current.raw) ?? state;
      if (expiryOf(currentState) - REFRESH_MARGIN_MS > Date.now()) {
        return { raw: current.raw, state: currentState };
      }
      const refreshed = await refreshNousToken(home, currentState);
      const merged = { ...currentState, ...refreshed };
      await persistRotatedState(current.path, current.raw, merged);
      return { raw: current.raw, state: merged };
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  const result = await refreshInFlight;
  return {
    home,
    path,
    raw: result.raw,
    state: result.state,
    token: result.state.access_token,
    inferenceBase,
    claims: decodeJwtClaims(result.state.access_token) ?? claims,
    refreshed: true,
  };
}

/** Re-read the stored session without refreshing (after a 401 the gateway may have rotated it). */
export async function rereadHermesSession(options = {}) {
  const home = hermesHomeFromEnv(options);
  const { raw } = await readAuthFile(home);
  const state = nousStateOf(raw);
  if (!state || typeof state.access_token !== 'string') return null;
  const claims = decodeJwtClaims(state.access_token) ?? {};
  return {
    home,
    state,
    token: state.access_token,
    inferenceBase: String(state.inference_base_url || claims.inference_base_url || DEFAULT_INFERENCE_BASE).replace(/\/+$/, ''),
    claims,
  };
}
