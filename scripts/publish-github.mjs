/**
 * 一次性发布脚本：用 GitHub Git Data API 把插件目录推成一次提交。
 * 用法: node scripts/publish-github.mjs <owner/repo> <branch> <commitMessage> [subdir]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN');
  process.exit(1);
}
const [repoArg, branch = 'main', message = 'chore: sync', subdirArg = ''] = process.argv.slice(2);
if (!repoArg) {
  console.error('用法: node scripts/publish-github.mjs <owner/repo> <branch> <message> [subdir]');
  process.exit(1);
}

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

const IGNORE_DIRS = new Set(['node_modules', '.git', '.github']);
const IGNORE_FILES = new Set(['.DS_Store']);

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

const sourceRoot = process.cwd();
const files = await walk(sourceRoot);
const prefix = subdirArg ? `${subdirArg.replace(/\/$/, '')}/` : '';

const repo = await api(`/repos/${repoArg}`);
let baseSha = null;
let baseTreeSha = null;
try {
  const ref = await api(`/repos/${repoArg}/git/ref/heads/${branch}`);
  baseSha = ref.object.sha;
  const commit = await api(`/repos/${repoArg}/git/commits/${baseSha}`);
  baseTreeSha = commit.tree.sha;
} catch (error) {
  console.log(`分支 ${branch} 不存在，将创建首个提交 (${error.message.slice(0, 80)})`);
}

const blobs = [];
for (const file of files) {
  const content = await readFile(file.full);
  const isBinary = content.includes(0);
  const blob = await api(`/repos/${repoArg}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify(
      isBinary
        ? { content: content.toString('base64'), encoding: 'base64' }
        : { content: content.toString('utf8'), encoding: 'utf-8' },
    ),
  });
  blobs.push({ path: `${prefix}${file.rel}`, sha: blob.sha, mode: '100644', type: 'blob' });
  process.stdout.write('.');
}
console.log(`\n上传 ${blobs.length} 个 blob`);

const tree = await api(`/repos/${repoArg}/git/trees`, {
  method: 'POST',
  body: JSON.stringify(baseTreeSha ? { base_tree: baseTreeSha, tree: blobs } : { tree: blobs }),
});

const commit = await api(`/repos/${repoArg}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: baseSha ? [baseSha] : [] }),
});

if (baseSha) {
  await api(`/repos/${repoArg}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
} else {
  await api(`/repos/${repoArg}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });
}

console.log(`OK ${repoArg}@${branch} -> ${commit.sha}`);
console.log(`https://github.com/${repoArg}/commit/${commit.sha}`);
