/**
 * Reads the model catalog that WorkBuddy / WorkBuddy AI already downloaded
 * from the Tencent product-config service.
 *
 * The catalog is the same data the desktop app renders: display name, credit
 * multiplier (`倍率`), context limits, reasoning levels, free promotions and
 * capability flags. Nothing here is hard-coded per model, so a new model
 * published by the agent appears in DeepSeek Harness after the app refreshes
 * its product config and DSH reloads the model directory.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PRODUCT_CONFIG_RE = /^acc-product-config-v3(?:-[0-9a-f]+)?\.json$/i;

/** Human-readable token counts used in model descriptions. */
export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(value % 1000 === 0 ? 0 : 1))}K`;
  return String(value);
}

/** Parse a catalog `credits` field such as `x3.47 credits` or `x0.00`. */
export function parseCredits(raw) {
  if (typeof raw !== 'string') return null;
  const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function creditsLabel(credits) {
  if (credits === null) return '';
  if (credits === 0) return '免费';
  return `倍率 ×${credits}`;
}

/** Map the product config's reasoning block to DSH reasoning metadata. */
function reasoningOf(model) {
  const source = model.reasoning;
  if (!source || model.supportsReasoning !== true) return undefined;
  const raw = Array.isArray(source.supportedEfforts)
    ? source.supportedEfforts
    : typeof source.efforts === 'string'
      ? [source.efforts]
      : Array.isArray(source.efforts)
        ? source.efforts
        : [];
  const ids = [...new Set(raw.filter((effort) => typeof effort === 'string' && effort.length > 0))];
  if (ids.length === 0) return undefined;
  const names = {
    minimal: '最少',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
  };
  const preferred = typeof source.defaultEffort === 'string' ? source.defaultEffort : source.effort;
  return {
    efforts: ids.map((id) => ({ id, name: names[id] ?? id })),
    ...(typeof preferred === 'string' && ids.includes(preferred) ? { defaultEffort: preferred } : {}),
  };
}

/**
 * Build one catalog entry. `name` carries the multiplier because the model
 * selector's `/model` popup renders catalog names without descriptions; the
 * composer label extension adds the free badge and tooltip on top.
 */
function catalogEntry(model, promotionFactor, sourceLabel) {
  const base = parseCredits(model.credits);
  const credits = promotionFactor !== null && base !== null ? Number((base * promotionFactor).toFixed(4)) : base;
  const free = credits !== null && credits <= 0;
  const badge = creditsLabel(credits);
  const name = badge.length > 0 ? `${model.name} · ${badge}` : model.name;
  const parts = [];
  if (badge.length > 0) parts.push(badge);
  if (Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0) parts.push(`上下文 ${formatTokens(model.maxInputTokens)}`);
  if (Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0) parts.push(`输出 ${formatTokens(model.maxOutputTokens)}`);
  const capabilities = [];
  if (model.supportsToolCall === true) capabilities.push('工具调用');
  if (model.supportsImages === true) capabilities.push('图像输入');
  if (model.supportsReasoning === true) capabilities.push('推理');
  if (capabilities.length > 0) parts.push(capabilities.join('/'));
  const localized = typeof model.descriptionZh === 'string' && model.descriptionZh.length > 0 ? model.descriptionZh : model.descriptionEn;
  if (typeof localized === 'string' && localized.length > 0) parts.push(localized);
  const description = `${parts.join(' · ')} · 来源 ${sourceLabel}`;
  return {
    id: model.id,
    name,
    description,
    context: Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0 ? { contextWindow: Math.trunc(model.maxInputTokens) } : undefined,
    defaultMaxTokens: Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0 ? Math.trunc(model.maxOutputTokens) : undefined,
    reasoning: reasoningOf(model),
    inputModalities: ['text'],
    credits,
    free,
    raw: model,
  };
}

function minutesOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Asia/Shanghai wall-clock minute of day (UTC+8, no DST).
 * @param {number} now epoch milliseconds
 */
function shanghaiMinuteOfDay(now) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function insideDailyWindow(now, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const current = shanghaiMinuteOfDay(now);
  for (const window of windows) {
    const start = minutesOfDay(window && window.start);
    const end = minutesOfDay(window && window.end);
    if (start === null || end === null) continue;
    if (start <= end) {
      if (current >= start && current < end) return true;
    } else if (current >= start || current < end) {
      /* Window wraps midnight, e.g. 23:00 → 07:50. */
      return true;
    }
  }
  return false;
}

/**
 * Active discount factor per model id, taking the lowest factor when several
 * promotions overlap (the same rule the WorkBuddy picker applies). Date
 * ranges, Asia/Shanghai daily windows, and badge-only promos are honored.
 * @returns {Map<string, number>}
 */
function activePromotions(config, now) {
  const factors = new Map();
  const promotions = Array.isArray(config.modelPromotions) ? config.modelPromotions : [];
  for (const promotion of promotions) {
    if (!promotion || promotion.enabled === false) continue;
    const factor = promotion.discount?.factor;
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) continue;
    const schedule = promotion.schedule;
    if (schedule) {
      const from = schedule.validFrom ? Date.parse(schedule.validFrom) : Number.NEGATIVE_INFINITY;
      const until = schedule.validUntil ? Date.parse(schedule.validUntil) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(from) && now < from) continue;
      if (Number.isFinite(until) && now >= until) continue;
      if (!insideDailyWindow(now, schedule.daily)) continue;
    }
    for (const id of Array.isArray(promotion.modelIds) ? promotion.modelIds : []) {
      const current = factors.get(id);
      factors.set(id, current === undefined ? factor : Math.min(current, factor));
    }
  }
  return factors;
}

/**
 * Read the newest usable product config from one WorkBuddy data root.
 * @param {string} dataRoot WorkBuddy data directory (e.g. `~/.workbuddy-ai`).
 * @returns {Promise<{config: object, path: string}|null>}
 */
export async function readProductConfig(dataRoot) {
  const cacheDir = join(dataRoot, 'cache');
  let names;
  try {
    names = await readdir(cacheDir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!PRODUCT_CONFIG_RE.test(name)) continue;
    const path = join(cacheDir, name);
    try {
      const info = await stat(path);
      candidates.push({ path, mtime: info.mtimeMs });
    } catch {
      /* Unreadable candidate; try the next one. */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate.path, 'utf8');
      const config = JSON.parse(text);
      if (config && Array.isArray(config.models) && config.models.length > 0) return { config, path: candidate.path };
    } catch {
      /* A partially written cache is normal while the app runs; skip it. */
    }
  }
  return null;
}

/**
 * Build the DSH model catalog for one WorkBuddy product.
 * @param {{dataRoot: string, sourceLabel: string}} options
 */
export async function loadWorkBuddyCatalog({ dataRoot, sourceLabel }) {
  const loaded = await readProductConfig(dataRoot);
  if (!loaded) return null;
  const promotionFactors = activePromotions(loaded.config, Date.now());
  const models = [];
  const seen = new Set();
  for (const model of loaded.config.models) {
    if (!model || typeof model.id !== 'string' || model.id.length === 0) continue;
    if (model.id.startsWith('custom-local:') || model.id.startsWith('custom:')) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const factor = promotionFactors.has(model.id) ? promotionFactors.get(model.id) : null;
    models.push(catalogEntry(model, factor, sourceLabel));
  }
  if (models.length === 0) return null;
  return {
    config: loaded.config,
    configPath: loaded.path,
    dataRoot,
    sourceLabel,
    endpoint: typeof loaded.config.endpoint === 'string' ? loaded.config.endpoint : undefined,
    officialEndpoints: Array.isArray(loaded.config.officialEndpoints) ? loaded.config.officialEndpoints : [],
    authentication: loaded.config.authentication ?? {},
    models,
  };
}

/** Public model-list view (drops the private `raw` payload). */
export function listView(models) {
  return models.map((model) => ({
    provider: undefined,
    id: model.id,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    inputModalities: model.inputModalities,
  }));
}

/** Exact-model view expected by `LlmAdapter.resolveModel`. */
export function resolveView(provider, models, modelId) {
  const model = models.find((entry) => entry.id === modelId);
  if (!model) {
    const error = new Error(`model "${modelId}" is not present in the ${provider} catalog`);
    error.code = 'MODEL_NOT_FOUND';
    throw error;
  }
  return {
    provider,
    id: model.id,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(model.context ? { context: model.context } : {}),
    ...(model.defaultMaxTokens ? { defaultMaxTokens: model.defaultMaxTokens } : {}),
    ...(model.reasoning ? { reasoning: model.reasoning } : {}),
    inputModalities: model.inputModalities,
  };
}

/** Default WorkBuddy data roots on this platform. */
export function defaultDataRoots() {
  const home = homedir();
  return {
    'workbuddy-ai': join(home, '.workbuddy-ai'),
    workbuddy: join(home, '.workbuddy'),
  };
}
