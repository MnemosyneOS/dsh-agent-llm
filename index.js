/**
 * dsh-agent-llm — Host half.
 *
 * Bridges the WorkBuddy / WorkBuddy AI / Hermes Agent accounts that are
 * already signed in on this computer into the Harness model selector.
 *
 * Upgrade-stability contract: this file imports only Node built-ins and uses
 * exactly one documented Harness seam, `ctx.llm.registerAdapter()`. It never
 * imports a Harness package, so a DSH upgrade can only affect it through a
 * deliberate change to that public seam.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AgentLlmAdapter } from './lib/adapter.js';
import { createWorkBuddyConnector } from './lib/workbuddy-connector.js';
import { createHermesConnector } from './lib/hermes-connector.js';
import { defaultAuthStores } from './lib/workbuddy-auth.js';
import {
  discoverHermesHomes,
  discoverWorkBuddyExecutables,
  workBuddyDataRoots,
} from './lib/discovery.js';
import { setDiscoveredExecutables } from './lib/workbuddy-auth.js';
import { setDiscoveredHermesHome } from './lib/hermes-auth.js';

export const inject = ['llm'];

function objectOption(value) {
  return value && typeof value === 'object' ? value : {};
}

function stringOption(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function detectAppVersion(exe, fallback) {
  try {
    const text = readFileSync(join(dirname(exe), 'version'), 'utf8').trim();
    if (/^\d+(?:\.\d+)+/.test(text)) return text;
  } catch {
    /* Version file is optional. */
  }
  return fallback;
}

function resolveOptions(config) {
  const settings = objectOption(config);
  const ai = objectOption(settings.workbuddyAi);
  const wb = objectOption(settings.workbuddy);
  const hermes = objectOption(settings.hermes);
  const roots = workBuddyDataRoots();
  return {
    workbuddyAi: {
      enabled: ai.enabled !== false,
      home: stringOption(ai.home, roots['workbuddy-ai']),
      authFile: stringOption(ai.authFile, defaultAuthStores()['workbuddy-ai'].file),
      appVersion: stringOption(ai.appVersion, undefined),
    },
    workbuddy: {
      enabled: wb.enabled !== false,
      home: stringOption(wb.home, roots.workbuddy),
      authFile: stringOption(wb.authFile, defaultAuthStores().workbuddy.file),
      appVersion: stringOption(wb.appVersion, undefined),
    },
    hermes: {
      enabled: hermes.enabled !== false,
      home: stringOption(hermes.home, discoverHermesHomes()[0]),
      allowRefresh: hermes.allowRefresh !== false,
    },
  };
}

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger;
  const options = resolveOptions(config);
  const connectors = [];

  /* 本机可执行文件与 Hermes 数据根只探测一次，结果注入到各自的模块里。 */
  const discoveredExes = ctx.effect(() => {
    let running = true;
    discoverWorkBuddyExecutables().then((paths) => {
      if (running) setDiscoveredExecutables(paths);
    }).catch(() => undefined);
    return () => {
      running = false;
    };
  });
  void discoveredExes;

  const workbuddySpecs = [
    {
      provider: 'workbuddy-ai',
      displayName: 'WorkBuddy AI',
      sourceLabel: 'WorkBuddy AI',
      home: options.workbuddyAi.home,
      authFile: options.workbuddyAi.authFile,
      appVersion: options.workbuddyAi.appVersion,
      fallbackVersion: '5.8.4',
      enabled: options.workbuddyAi.enabled,
    },
    {
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      sourceLabel: 'WorkBuddy',
      home: options.workbuddy.home,
      authFile: options.workbuddy.authFile,
      appVersion: options.workbuddy.appVersion,
      fallbackVersion: '5.8.3',
      enabled: options.workbuddy.enabled,
    },
  ];

  const exeCandidates = [];

  for (const spec of workbuddySpecs) {
    if (!spec.enabled) continue;
    if (!existsSync(spec.home)) {
      log?.warn?.(`dsh-agent-llm: ${spec.displayName} 数据目录不存在（${spec.home}），跳过该 provider。若已安装，请在插件配置里指定 home。`);
      continue;
    }
    try {
      connectors.push(
        createWorkBuddyConnector({
          provider: spec.provider,
          displayName: spec.displayName,
          sourceLabel: spec.sourceLabel,
          dataRoot: spec.home,
          authFile: spec.authFile,
          exeCandidates,
          appVersion: detectAppVersion(exeCandidates[0] ?? '', spec.appVersion ?? spec.fallbackVersion),
          log,
        }),
      );
    } catch (error) {
      log?.warn?.(`dsh-agent-llm: 初始化 ${spec.displayName} 失败：${error && error.message ? error.message : error}`);
    }
  }

  if (options.hermes.enabled && options.hermes.home && existsSync(join(options.hermes.home, 'auth.json'))) {
    try {
      setDiscoveredHermesHome(options.hermes.home);
      connectors.push(
        createHermesConnector({
          provider: 'hermes-agent',
          displayName: 'Hermes Agent',
          home: options.hermes.home,
          allowRefresh: options.hermes.allowRefresh,
          log,
        }),
      );
    } catch (error) {
      log?.warn?.(`dsh-agent-llm: 初始化 Hermes Agent 失败：${error && error.message ? error.message : error}`);
    }
  } else if (options.hermes.enabled) {
    log?.warn?.('dsh-agent-llm: 未发现已登录的 Hermes Agent（缺少 auth.json），跳过该 provider');
  }

  if (connectors.length === 0) {
    log?.warn?.('dsh-agent-llm: 未发现可桥接的 Agent 登录状态，插件空闲');
    return;
  }

  const adapter = new AgentLlmAdapter(connectors, { log });
  const registration = ctx.llm.registerAdapter(
    connectors.map((connector) => connector.provider),
    adapter,
  );
  /* The registration is owned by this plugin fiber: unloading or reloading the
     row removes the routes before a fresh generation registers them again. */
  ctx.effect(() => registration);
  log?.info?.(`dsh-agent-llm: 已注册 ${connectors.map((connector) => connector.provider).join(', ')}`);
}
