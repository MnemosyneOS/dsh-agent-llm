/**
 * 本机 Agent 安装位置自动发现。
 *
 * 插件不能假设任何人把 WorkBuddy / Hermes 装在同一目录：这里在启动和每次
 * 需要凭据时按「环境变量 → 注册表卸载信息 → 平台常见安装位置 → 通用浅层扫描」
 * 的顺序探测，找到第一个真实存在的候选就使用。插件 row config 里的显式路径永远优先。
 *
 * 所有候选都是**通用**路径形态（用户目录、系统程序目录、盘符根目录），
 * 不含任何特定用户的私有布局。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 已知的 Agent 目录名（用于通用浅层扫描）。 */
const WORKBUDDY_DIR_NAMES = ['WorkBuddyAI', 'WorkBuddy', 'workbuddy-ai', 'workbuddy'];
const HERMES_DIR_NAMES = ['HermesAgent', 'hermes-agent', 'Hermes', 'hermes'];

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

/** 可扫描的盘符根目录（Windows）或挂载点根（其它平台）。 */
function driveRoots() {
  if (platform() !== 'win32') return ['/'];
  const roots = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    if (isDir(root)) roots.push(root);
  }
  return roots;
}

/**
 * 通用浅层扫描：在给定根目录下按目录名找 Agent 安装目录，深度受限。
 *
 * 这是给「装在非标准位置」的用户兜底的能力，不依赖任何特定机器的目录布局：
 * 只看目录名是否匹配已知 Agent 名称，不读取目录内容。
 *
 * @param {string[]} roots 扫描起点
 * @param {string[]} names 目标目录名（不区分大小写）
 * @param {number} maxDepth 最大深度（默认 3）
 * @param {number} maxEntries 每个目录最多遍历的条目数（防止超慢）
 * @returns {string[]} 命中的目录绝对路径
 */
export function shallowFindDirs(roots, names, maxDepth = 3, maxEntries = 120) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const hits = [];
  const seen = new Set();

  const visit = (dir, depth) => {
    if (depth > maxDepth || hits.length >= 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let count = 0;
    for (const entry of entries) {
      if (count++ > maxEntries || hits.length >= 8) return;
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      if (wanted.has(entry.name.toLowerCase())) hits.push(full);
      /* 系统目录与明显的非项目目录不深入，避免拖慢启动。 */
      if (/^(Windows|Program Files|Program Files \(x86\)|ProgramData|System Volume Information|node_modules|\.git|AppData)$/i.test(entry.name)) {
        continue;
      }
      visit(full, depth + 1);
    }
  };

  for (const root of roots) {
    if (!isDir(root)) continue;
    /* 根目录本身也参与名称匹配（例如直接把 Agent 装成盘符下一级）。 */
    visit(root, 1);
    if (hits.length >= 8) break;
  }
  return [...new Set(hits)];
}

/** 扫描起点：用户目录 + 各盘符根目录。 */
function scanRoots() {
  const home = homedir();
  const roots = [home, join(home, 'Documents'), join(home, 'Desktop'), join(localAppData(), 'Programs')];
  roots.push(...driveRoots());
  return [...new Set(roots.filter((root) => isDir(root)))];
}

/** WorkBuddy AI / WorkBuddy 数据根（`~/.workbuddy-ai`、`~/.workbuddy`）。 */
export function workBuddyDataRoots() {
  const home = homedir();
  const found = {
    'workbuddy-ai': firstExisting([process.env.WORKBUDDY_AI_HOME, join(home, '.workbuddy-ai')]),
    workbuddy: firstExisting([process.env.WORKBUDDY_HOME, join(home, '.workbuddy')]),
  };
  return found;
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
    '/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy AI',
    '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
  ];
  const registry = [];
  for (const pattern of ['WorkBuddy AI', 'WorkBuddy', 'WorkBuddyAI']) {
    for (const dir of await windowsInstallLocations(pattern)) {
      registry.push(join(dir, 'WorkBuddyAI.exe'), join(dir, 'WorkBuddy.exe'), join(dir, 'resources', 'WorkBuddyAI.exe'));
    }
  }
  /* 兜底：通用浅层扫描找安装目录，再拼可执行文件名。
     注意不能因为「已经找到一个 exe」就跳过：WorkBuddy 与 WorkBuddy AI 是两个
     产品，各自的可执行文件都要给出，才能分别读到各自的 at-rest 密钥。 */
  const scanned = [];
  for (const dir of shallowFindDirs(scanRoots(), WORKBUDDY_DIR_NAMES)) {
    scanned.push(join(dir, 'WorkBuddyAI.exe'), join(dir, 'WorkBuddy.exe'));
    const nested = join(dir, 'resources');
    if (isDir(nested)) scanned.push(join(nested, 'WorkBuddyAI.exe'));
  }
  const merged = [...new Set([...explicit, ...registry, ...common, ...scanned])];
  return merged.filter((path) => existsSync(path));
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
    join(home, '.hermes', 'home'),
    join(local, 'Programs', 'Hermes', 'home'),
    join(local, 'hermes', 'home'),
    join(home, '.config', 'hermes', 'home'),
  ].filter((value) => typeof value === 'string' && value.length > 0);

  const out = [];
  const accept = (dir) => {
    if (!isDir(dir)) return;
    if (existsSync(join(dir, 'auth.json')) || existsSync(join(dir, 'config.yaml'))) {
      if (!out.includes(dir)) out.push(dir);
    }
  };
  for (const candidate of candidates) accept(candidate);
  if (out.length > 0) return out;

  /* 兜底：通用浅层扫描找 Hermes 目录，再检查其自身与 home/ 子目录。 */
  for (const dir of shallowFindDirs(scanRoots(), HERMES_DIR_NAMES)) {
    accept(dir);
    accept(join(dir, 'home'));
  }
  return out;
}

/** 第一个可用的 Hermes 数据根；找不到时返回 undefined。 */
export function hermesHomeDefault() {
  return discoverHermesHomes()[0];
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
