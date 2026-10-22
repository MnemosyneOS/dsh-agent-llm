#!/usr/bin/env node
/**
 * 经 DSH 本体做端到端验证：新建临时会话，依次切换三个 provider 的免费模型，
 * 读取会话投影确认「实际使用的 provider/model」与回答。
 *
 * 需要本机正在运行 `dsh web`。会自动从 DSH 启动日志里取当前访问令牌，
 * 也可以用环境变量覆盖：
 *   DSH_WEB_URL   例如 http://127.0.0.1:3080
 *   DSH_WEB_TOKEN 访问令牌
 *   DSH_WEB_LOG   dsh web 的输出日志路径（默认扫描常见位置）
 *
 * 只使用免费模型；测试会话结束后自动归档。
 */
import { readFile, mkdir } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const HOME = homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh');
const PROJ_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');

const TARGETS = [
  { provider: 'workbuddy', model: 'hy3', label: 'WorkBuddy' },
  { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', label: 'WorkBuddy AI' },
  { provider: 'hermes-agent', model: 'meituan/longcat-2.5-preview:free', label: 'Hermes Agent' },
];

function rpcId() {
  return createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex');
}

/** 从 dsh web 日志里找最近一次带令牌的访问 URL。 */
async function findWebUrl() {
  const candidates = [
    process.env.DSH_WEB_LOG,
    join(HOME, 'dsh-web.log'),
    join(HOME, '.dsh', 'dsh-web.log'),
    join(HOME, 'dsh', 'web.log'),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, 'utf8');
    const matches = [...text.matchAll(/dsh web: (http:\/\/\S+\?token=[A-Za-z0-9_-]+)/g)];
    if (matches.length > 0) return matches[matches.length - 1][1];
  }
  return undefined;
}

async function auth() {
  const token = process.env.DSH_WEB_TOKEN;
  const url = process.env.DSH_WEB_URL || (await findWebUrl());
  const origin = url ? new URL(url).origin : 'http://127.0.0.1:3080';
  if (token) return { cookie: `dsh_web_token=${token}`, origin };
  if (!url) {
    throw new Error(
      '找不到 dsh web 访问地址：请设置 DSH_WEB_URL / DSH_WEB_TOKEN，或用 DSH_WEB_LOG 指定 dsh web 日志路径',
    );
  }
  const response = await fetch(url, { redirect: 'manual' });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`令牌交换失败（HTTP ${response.status}）`);
  return { cookie, origin };
}

function makeRpc(session) {
  const { cookie, origin } = session;
  return async function rpc(channel, method, args = {}) {
    const endpoint = `${channel}/${method}`;
    const body = { type: 'client-request', rpcId: rpcId(), method: endpoint, payload: { args } };
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    if (!parsed.result || parsed.result.ok !== true) {
      const error = parsed.result && parsed.result.error;
      throw new Error(`${endpoint}: ${error ? `${error.code}: ${error.message}` : 'rejected'}`);
    }
    return parsed.result.value;
  };
}

async function projectionOf(sessionId) {
  for (const path of [join(PROJ_DIR, `${sessionId}.json`), join(PROJ_DIR, `session-${sessionId}.json`)]) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      /* 换一种命名再试 */
    }
  }
  return null;
}

/** 从会话日志里取最后一次尝试的失败原因，便于定位 provider 报错。 */
function lastAttemptError(sessionId) {
  try {
    for (const dir of readdirSync(SESSIONS_DIR)) {
      const candidate = join(SESSIONS_DIR, dir, sessionId);
      if (!existsSync(candidate)) continue;
      const file = join(candidate, 'session.v4.jsonl.zstd');
      if (!existsSync(file)) continue;
      const buffer = readFileSync(file);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      const offsets = [];
      let index = 0;
      while ((index = buffer.indexOf(magic, index)) >= 0) {
        offsets.push(index);
        index += 4;
      }
      const lines = [];
      for (let k = 0; k < offsets.length; k += 1) {
        const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length;
        try {
          lines.push(...zstdDecompressSync(buffer.subarray(offsets[k], end)).toString('utf8').split('\n'));
        } catch {
          /* 半写入的帧跳过 */
        }
      }
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line || !line.includes('assistant/attempt')) continue;
        try {
          const event = JSON.parse(line);
          for (const item of (event.data && event.data.stream) || []) {
            const finish = item && item.chunk && item.chunk.finish;
            if (finish && finish.reason && finish.reason.kind === 'error') {
              return finish.reason.failure && finish.reason.failure.message;
            }
          }
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
  } catch {
    /* 诊断信息缺失不影响主流程 */
  }
  return undefined;
}

async function waitForTurn(sessionId, turnNumber, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await projectionOf(sessionId);
    const rows = last && last.record && last.record.rows;
    const turns = rows && rows.turnOutline && rows.turnOutline.val && rows.turnOutline.val.turns;
    const stats = rows && rows.sessionStats && rows.sessionStats.val;
    if (turns && turns.length >= turnNumber && stats && stats.openStep === null) {
      return { turn: turns[turnNumber - 1], selection: rows.modelSelection && rows.modelSelection.val };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const rows = last && last.record && last.record.rows;
  throw new Error(
    `第 ${turnNumber} 轮未结束；最后状态：${JSON.stringify(rows && rows.turnOutline && rows.turnOutline.val)}`.slice(0, 400),
  );
}

async function main() {
  const session = await auth();
  const rpc = makeRpc(session);
  const cwd = join(DSH_HOME, 'tmp', 'dsh-agent-llm-e2e');
  await mkdir(cwd, { recursive: true });

  const catalog = await rpc('session', 'modelCatalog');
  const routed = new Set(catalog.routableProviders ?? []);
  const targets = TARGETS.filter((target) => routed.has(target.provider));
  if (targets.length === 0) throw new Error('模型库中没有本插件注册的 provider');
  console.log('模型库 provider:', [...routed].join(', '));

  const created = await rpc('session', 'create', { request: { cwd, agentPreset: 'cordis' } });
  const sessionId = created.sessionId;
  console.log('测试会话:', sessionId);

  const results = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const turnNumber = index + 1;
      try {
        await rpc('session', 'selectModel', {
          request: { sessionId, provider: target.provider, model: target.model },
        });
        console.log(`\n[${target.label}] 已选择 ${target.provider}/${target.model}`);
        await rpc('session', 'prompt', {
          request: {
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: `只回复这一串字符，不要调用工具：${target.label.replace(/\s+/g, '')}-OK` }],
            clientTimeZone: 'Asia/Shanghai',
          },
        });
        const settled = await waitForTurn(sessionId, turnNumber);
        const used = settled.selection && settled.selection.lastUsed;
        const reply = ((settled.turn && settled.turn.response) || '').trim();
        const ok = used && used.provider === target.provider && used.model === target.model && reply.length > 0;
        console.log(`  实际路由: ${used ? `${used.provider}/${used.model}` : '(未知)'}`);
        console.log(`  回答: ${JSON.stringify(reply.slice(0, 120))}`);
        if (!ok) {
          const failure = lastAttemptError(sessionId);
          if (failure) console.log(`  provider 报错: ${failure.slice(0, 300)}`);
        }
        console.log(`  ${ok ? 'PASS' : 'FAIL'}`);
        results.push({ target, used, reply: reply.slice(0, 300), ok });
      } catch (error) {
        console.log(`\n[${target.label}] ERROR ${error && error.message ? error.message : error}`);
        results.push({ target, ok: false, error: String(error && error.message ? error.message : error) });
      }
    }
  } finally {
    await rpc('workspace', 'archiveSession', { request: { sessionId, stopActivity: true } }).catch(() => undefined);
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('E2E ERROR:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
