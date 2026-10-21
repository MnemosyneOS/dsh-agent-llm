/**
 * 本机 Agent 安装位置自动发现。
 *
 * 插件不能假设任何人把 WorkBuddy / Hermes 装在同一目录：这里在启动和每次
 * 需要凭据时按「环境变量 → 注册表卸载信息 → 平台常见安装位置」的顺序探测，
 * 找到第一个真实存在的候选就使用。插件 row config 里的显式路径永远优先。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function localAppData() {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

/** 返回第一个真实存在的路径。 */
export function firstExisting(paths) {
  for (const candidate of paths) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Windows 卸载表里的安装目录（`reg query` 输出按空行分块）。
 * @param {string} displayPattern 匹配 DisplayName 的子串
 */
async function windowsInstallLocations(displayPattern) {
  if (platform() !== 'win32') return [];
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const found = [];
  for (const root of roots) {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('reg', ['query', root, '/s', '/f', displayPattern, '/d', '/e'], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      }));
    } catch {
      continue;
    }
    let location = null;
    let matched = false;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('HKEY_')) {
        if (matched && location) found.push(location);
        location = null;
        matched = false;
        continue;
      }
      const entry = /^\s*(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line);
      if (!entry) continue;
      const [, name, value] = entry;
      if (name.trim() === 'DisplayName' && value.includes(displayPattern)) matched = true;
      if (name.trim() === 'InstallLocation' && value.trim().length > 0) location = value.trim();
    }
    if (matched && location) found.push(location);
  }
  return found.filter((path) => isDir(path));
}

/** WorkBuddy AI / WorkBuddy 数据根（`~/.workbuddy-ai`、`~/.workbuddy`）。 */
export function workBuddyDataRoots() {
  const home = homedir();
  return {
    'workbuddy-ai': firstExisting([
      process.env.WORKBUDDY_AI_HOME,
      join(home, '.workbuddy-ai'),
    ]),
    workbuddy: firstExisting([
      process.env.WORKBUDDY_HOME,
      join(home, '.workbuddy'),
    ]),
  };
}

/**
 * WorkBuddy / WorkBuddy AI 可执行文件候选（用于读取本地加密密钥）。
 * @returns {Promise<string[]>}
 */
export async function discoverWorkBuddyExecutables() {
  const home = homedir();
  const local = localAppData();
  const explicit = [process.env.DSH_AGENT_LLM_WORKBUDDY_AI_EXE, process.env.DSH_AGENT_LLM_WORKBUDDY_EXE].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  const common = [
    join(local, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'C:\\AI_Workspace\\01_Agents\\WorkBuddyAI\\WorkBuddyAI.exe',
    'C:\\AI_Workspace\\01_Agents\\WorkBuddy\\WorkBuddy.exe',
    join(home, 'AppData', 'Local', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    '/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy AI',
    '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
  ];
  const registry = [];
  for (const pattern of ['WorkBuddy AI', 'WorkBuddy', 'WorkBuddyAI']) {
    for (const dir of await windowsInstallLocations(pattern)) {
      registry.push(join(dir, 'WorkBuddyAI.exe'), join(dir, 'WorkBuddy.exe'), join(dir, 'resources', 'WorkBuddyAI.exe'));
    }
  }
  return [...new Set([...explicit, ...registry, ...common])].filter((path) => existsSync(path));
}

/**
 * Hermes Agent 数据根（`HERMES_HOME`）候选。
 * 判定标准：目录下存在 auth.json 或 config.yaml。
 */
export function discoverHermesHomes() {
  const home = homedir();
  const local = localAppData();
  const candidates = [
    process.env.HERMES_HOME,
    join(home, '.hermes'),
    join(home, 'HermesAgent', 'home'),
    join(local, 'Programs', 'Hermes', 'home'),
    join(local, 'hermes', 'home'),
    'C:\\AI_Workspace\\01_Agents\\HermesAgent\\home',
    join(home, '.config', 'hermes', 'home'),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const out = [];
  for (const candidate of candidates) {
    if (!isDir(candidate)) continue;
    if (existsSync(join(candidate, 'auth.json')) || existsSync(join(candidate, 'config.yaml'))) out.push(candidate);
  }
  return out;
}

/** 第一个可用的 Hermes 数据根；找不到时返回 undefined。 */
export function hermesHomeDefault() {
  return [...new Set(discoverHermesHomes())][0];
}

/**
 * 在若干根目录下做一层浅层搜索，找出 WorkBuddy / Hermes 安装目录。
 * 只在常规探测全部失败时调用，深度受限以避免长时间扫描。
 */
export function shallowSearch(roots, matcher) {
  const out = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 200)) {
      const path = join(root, entry);
      try {
        if (matcher(path)) out.push(path);
      } catch {
        /* 无权限或已消失，跳过 */
      }
    }
  }
  return out;
}

/** 供诊断脚本与日志使用的一次性摘要（不含任何凭据）。 */
export async function discoveryReport() {
  const roots = workBuddyDataRoots();
  const exes = await discoverWorkBuddyExecutables();
  return {
    platform: platform(),
    workbuddyAiHome: roots['workbuddy-ai'],
    workbuddyHome: roots.workbuddy,
    workbuddyExecutables: exes,
    hermesHomes: discoverHermesHomes(),
  };
}

export { roamingAppData, localAppData };
