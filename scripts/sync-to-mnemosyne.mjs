/**
 * 把 dsh-agent-llm 同步进 MnemosyneOS/mnemosyne 仓库的 dsh-plugin/ 目录，
 * 并在两个 marketplace 清单里登记。可重复执行（幂等）。
 *
 * 用法: GITHUB_TOKEN=... node scripts/sync-to-mnemosyne.mjs
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN');
  process.exit(1);
}

const REPO = 'MnemosyneOS/mnemosyne';
const BRANCH = 'main';
const DEST = 'dsh-plugin';
const API = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-agent-llm-publisher',
  'content-type': 'application/json',
};

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return body;
}

async function blob(content) {
  return api(`/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'tests', 'scripts', '.github']);
const IGNORE_FILES = new Set(['.DS_Store', '.gitignore', 'market-index.json']);

async function walk(root, current = root, out = []) {
  for (const name of await readdir(current)) {
    const full = join(current, name);
    const info = await stat(full);
    if (info.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      await walk(root, full, out);
      continue;
    }
    if (IGNORE_FILES.has(name)) continue;
    if (name.endsWith('.zip')) continue;
    out.push({ full, rel: relative(root, full).split(sep).join('/') });
  }
  return out;
}

const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
const headSha = ref.object.sha;
const headCommit = await api(`/repos/${REPO}/git/commits/${headSha}`);
const baseTree = headCommit.tree.sha;

const entries = [];
for (const file of await walk(process.cwd())) {
  const content = await readFile(file.full, 'utf8');
  entries.push({ path: `${DEST}/${file.rel}`, mode: '100644', type: 'blob', sha: (await blob(content)).sha });
  process.stdout.write('.');
}
console.log(`\n插件文件 ${entries.length} 个`);

/* 1) .dsh-plugin/plugin.json —— 与仓库其它平台目录一致的描述文件 */
const pluginManifest = {
  name: 'dsh-agent-llm',
  version: JSON.parse(await readFile('package.json', 'utf8')).version,
  description:
    'DeepSeek Harness plugin: bridge the WorkBuddy / WorkBuddy AI / Hermes Agent accounts already signed in on this computer into the DSH model library, with each agent own model names, credit multipliers and free badges.',
  homepage: 'https://github.com/MnemosyneOS/dsh-agent-llm',
  repository: 'https://github.com/MnemosyneOS/dsh-agent-llm',
  license: 'MIT',
  install: {
    dsh: 'dsh plugin --profile web add github:MnemosyneOS/dsh-agent-llm',
    skillhub: { owner: 'MnemosyneOS', name: 'dsh-agent-llm' },
  },
  keywords: ['dsh-plugin', 'deepseek-harness', 'llm-provider', 'model-inference', 'workbuddy', 'hermes-agent'],
};
entries.push({
  path: `${DEST}/plugin.json`,
  mode: '100644',
  type: 'blob',
  sha: (await blob(`${JSON.stringify(pluginManifest, null, 2)}\n`)).sha,
});

/* 2) 两个 marketplace 清单登记 */
async function registerIn(path, mutate) {
  const file = await api(`/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  const next = mutate(JSON.parse(text));
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (serialized === text) {
    console.log(`- ${path} 已包含该插件，跳过`);
    return;
  }
  entries.push({ path, mode: '100644', type: 'blob', sha: (await blob(serialized)).sha });
  console.log(`+ ${path} 已更新`);
}

const pluginEntry = {
  name: 'dsh-agent-llm',
  source: `./${DEST}`,
  description:
    'DeepSeek Harness plugin that bridges the WorkBuddy / WorkBuddy AI / Hermes Agent models already signed in on the machine into the DSH model library.',
  tags: ['dsh', 'deepseek-harness', 'llm-provider', 'model-inference'],
};

for (const path of ['.agents/plugins/marketplace.json', 'marketplace.json']) {
  await registerIn(path, (doc) => {
    const list = Array.isArray(doc.plugins) ? doc.plugins : [];
    if (list.some((item) => item && item.name === 'dsh-agent-llm')) return doc;
    return { ...doc, plugins: [...list, pluginEntry] };
  });
}

const tree = await api(`/repos/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: baseTree, tree: entries }),
});
const commit = await api(`/repos/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message:
      'feat(dsh-plugin): add dsh-agent-llm 1.1.0 — bridge WorkBuddy / WorkBuddy AI / Hermes Agent models into DeepSeek Harness',
    tree: tree.sha,
    parents: [headSha],
  }),
});
await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
});
console.log(`OK ${REPO}@${BRANCH} -> ${commit.sha}`);
console.log(`https://github.com/${REPO}/commit/${commit.sha}`);
