/**
 * Hermes Agent model catalog.
 *
 * Hermes' real model inventory is its Nous Portal provider list. The local
 * caches (`cache/nous_recommended_cache.json` and `context_length_cache.yaml`)
 * are written by Hermes itself and survive updates, so they are the offline
 * source of truth; a live `/v1/models` call refines availability when the
 * stored OAuth token is still usable.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveHermesSession, hermesHomeFromEnv } from './hermes-auth.js';

const CATALOG_TTL_MS = 60_000;

function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse `context_length_cache.yaml`: a `context_lengths:` map whose keys are
 * `model[@base_url]` and whose values are numbers (inline or on the next line).
 */
export function parseContextLengths(text) {
  const result = new Map();
  if (!text) return result;
  const lines = text.split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const withValue = /^\s{2,}(.+?):\s*(\d+)\s*$/.exec(line);
    if (withValue) {
      result.set(withValue[1].trim(), Number(withValue[2]));
      key = null;
      continue;
    }
    const bare = /^\s{2,}(.+?):\s*$/.exec(line);
    if (bare) {
      key = bare[1].trim();
      continue;
    }
    const continuation = /^\s{4,}(\d+)\s*$/.exec(line);
    if (continuation && key) {
      result.set(key, Number(continuation[1]));
      key = null;
    }
  }
  return result;
}

async function readRecommended(home) {
  const text = await readText(join(home, 'cache', 'nous_recommended_cache.json'));
  if (!text) return { free: [], paid: [], ts: 0 };
  try {
    const raw = parseJson(text);
    const entries = Object.values(raw);
    entries.sort((a, b) => Number(b && b.ts ? b.ts : 0) - Number(a && a.ts ? a.ts : 0));
    const data = entries[0] && entries[0].data ? entries[0].data : {};
    return {
      free: Array.isArray(data.freeRecommendedModels) ? data.freeRecommendedModels : [],
      paid: Array.isArray(data.paidRecommendedModels) ? data.paidRecommendedModels : [],
      ts: entries[0] && entries[0].ts ? entries[0].ts : 0,
    };
  } catch {
    return { free: [], paid: [], ts: 0 };
  }
}

function findContext(contextLengths, id) {
  if (contextLengths.has(id)) return contextLengths.get(id);
  for (const [key, value] of contextLengths) {
    if (key === id || key.startsWith(`${id}@`)) return value;
  }
  return undefined;
}

function displayFor(id, recommended, free) {
  const match = recommended.find((entry) => entry && entry.modelName === id);
  let name = match && typeof match.displayName === 'string' && match.displayName.length > 0 ? match.displayName : id;
  if (free && !/free|免费/i.test(name)) name = `${name} · 免费`;
  return name;
}

function entryFor(provider, id, { recommended, contextLengths, free, paidAccess }) {
  const contextWindow = findContext(contextLengths, id) ?? (recommended.find((m) => m && m.modelName === id)?.contextLength ?? undefined);
  const price = recommended.find((m) => m && m.modelName === id)?.tokenPrice;
  const parts = [];
  if (free) parts.push('免费');
  else if (paidAccess) parts.push('Nous 付费模型');
  if (Number.isFinite(contextWindow) && contextWindow > 0) parts.push(`上下文 ${formatTokens(contextWindow)}`);
  if (typeof price === 'string' && price.length > 0) parts.push(price);
  parts.push('来源 Hermes Agent（Nous）');
  return {
    provider,
    id,
    name: displayFor(id, recommended, free),
    description: parts.join(' · '),
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { context: { contextWindow } } : {}),
    inputModalities: ['text'],
    free,
  };
}

/**
 * Build the Hermes Agent catalog.
 * @param {{home?: string, provider: string, log?: object}} options
 */
export async function loadHermesCatalog(options) {
  const home = hermesHomeFromEnv(options);
  const recommended = await readRecommended(home);
  const contextLengths = parseContextLengths(await readText(join(home, 'context_length_cache.yaml')));
  let claims = {};
  let liveIds = [];
  let tokenUsable = false;
  try {
    const session = await resolveHermesSession({ home, allowRefresh: false });
    claims = session.claims ?? {};
    tokenUsable = true;
  } catch {
    tokenUsable = false;
  }
  const paidAccess = claims.paid_access === true;
  if (tokenUsable) {
    try {
      const session = await resolveHermesSession({ home, allowRefresh: false });
      const response = await fetch(`${session.inferenceBase}/models`, {
        headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const payload = await response.json();
        liveIds = Array.isArray(payload.data)
          ? payload.data.map((model) => model && (model.id || model.name)).filter((id) => typeof id === 'string')
          : [];
      }
    } catch {
      liveIds = [];
    }
  }

  const freeRecommended = recommended.free.filter((m) => m && typeof m.modelName === 'string');
  const orderedFree = [];
  const seen = new Set();
  for (const model of freeRecommended) {
    if (seen.has(model.modelName)) continue;
    seen.add(model.modelName);
    orderedFree.push(model.modelName);
  }
  for (const id of liveIds) {
    if (!id.endsWith(':free') || seen.has(id)) continue;
    seen.add(id);
    orderedFree.push(id);
  }

  const models = [];
  for (const id of orderedFree) {
    models.push(entryFor(options.provider, id, { recommended: freeRecommended, contextLengths, free: true, paidAccess }));
  }
  if (paidAccess) {
    for (const model of recommended.paid) {
      if (!model || typeof model.modelName !== 'string' || seen.has(model.modelName)) continue;
      seen.add(model.modelName);
      models.push(entryFor(options.provider, model.modelName, { recommended: recommended.paid, contextLengths, free: false, paidAccess }));
    }
    for (const id of liveIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(entryFor(options.provider, id, { recommended: [], contextLengths, free: false, paidAccess }));
    }
  }

  return { home, provider: options.provider, models, paidAccess, claims, live: liveIds.length > 0, ts: recommended.ts };
}

export { CATALOG_TTL_MS };
