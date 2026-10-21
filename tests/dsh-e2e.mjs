#!/usr/bin/env node
/**
 * End-to-end verification through the LIVE DeepSeek Harness Host.
 *
 * Creates one temporary DSH session, selects each bridged provider in turn
 * (WorkBuddy AI → WorkBuddy → Hermes Agent), sends a one-line prompt, and
 * reads the session projection cache to prove the answer came from that exact
 * provider/model. Only free models are used.
 *
 * Run: node tests/dsh-e2e.mjs
 */
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const HOME = process.env.USERPROFILE;
const WORKSPACE = 'C:\\AI_Workspace\\01_Agents\\deepseek-harness\\Mnemosyne OS';
const CWD = join(WORKSPACE, '.dsh-e2e-tmp');
const LOG = 'C:\\AI_Workspace\\01_Agents\\dsh-ops\\dsh-web.log';
const PROJ_DIR = join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');

const TARGETS = [
  { provider: 'workbuddy', model: 'hy3', label: 'WorkBuddy' },
  { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', label: 'WorkBuddy AI' },
  { provider: 'hermes-agent', model: 'meituan/longcat-2.5-preview:free', label: 'Hermes Agent' },
];

function uuid() {
  return crypto.randomUUID();
}
function rpcId() {
  return createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex');
}

async function auth() {
  const text = await readFile(LOG, 'utf8');
  const matches = [...text.matchAll(/dsh web: (http:\/\/\S+\?token=[A-Za-z0-9_-]+)/g)];
  if (matches.length === 0) throw new Error('no dsh web URL/token in log');
  const url = matches[matches.length - 1][1];
  const response = await fetch(url, { redirect: 'manual' });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`token exchange returned ${response.status} without a cookie`);
  return cookie;
}

function makeRpc(cookie) {
  return async function rpc(channel, method, args = {}) {
    const endpoint = `${channel}/${method}`;
    const body = { type: 'client-request', rpcId: rpcId(), method: endpoint, payload: { args } };
    const response = await fetch(`http://127.0.0.1:3080/api/${endpoint}`, {
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
      throw new Error(`${channel}/${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    if (!parsed.result || parsed.result.ok !== true) {
      const error = parsed.result && parsed.result.error;
      throw new Error(`${channel}/${method}: ${error ? `${error.code}: ${error.message}` : 'rejected'}`);
    }
    return parsed.result.value;
  };
}

async function projectionOf(sessionId) {
  const candidates = [join(PROJ_DIR, `${sessionId}.json`), join(PROJ_DIR, `session-${sessionId}.json`)];
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      /* try the next naming form */
    }
  }
  return null;
}

function lastAttemptError(sessionId) {
  const root = join(HOME, '.dsh', 'sessions');
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, sessionId);
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
        } catch {}
      }
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line || !line.includes('assistant/attempt')) continue;
        try {
          const event = JSON.parse(line);
          const stream = (event.data && event.data.stream) || [];
          for (const item of stream) {
            const finish = item && item.chunk && item.chunk.finish;
            if (finish && finish.reason && finish.reason.kind === 'error') return finish.reason.failure && finish.reason.failure.message;
          }
        } catch {}
      }
    }
  } catch {}
  return undefined;
}

async function retry(operation, { attempts = 20, delayMs = 1000, what = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function waitForTurn(sessionId, turnNumber, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await projectionOf(sessionId);
    const rows = last && last.record && last.record.rows;
    const turns = rows && rows.turnOutline && rows.turnOutline.val && rows.turnOutline.val.turns;
    const stats = rows && rows.sessionStats && rows.sessionStats.val;
    if (turns && turns.length >= turnNumber) {
      const turn = turns[turnNumber - 1];
      if (turn && stats && stats.openStep === null) {
        return { turn, selection: rows.modelSelection && rows.modelSelection.val };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`turn ${turnNumber} did not settle; last projection: ${JSON.stringify(last && last.record && last.record.rows && last.record.rows.turnOutline && last.record.rows.turnOutline.val)}`.slice(0, 500));
}

async function main() {
  await mkdir(CWD, { recursive: true });
  const cookie = await auth();
  const rpc = makeRpc(cookie);

  const catalog = await rpc('session', 'modelCatalog');
  const routed = new Set(catalog.routableProviders ?? []);
  for (const target of TARGETS) {
    if (!routed.has(target.provider)) throw new Error(`provider not routable in model library: ${target.provider}`);
  }
  console.log('model library providers:', [...routed].join(', '));

  const created = await rpc('session', 'create', { request: { cwd: CWD, agentPreset: 'cordis' } });
  const sessionId = created.sessionId;
  console.log('test session:', sessionId);
  try {
    await rpc('session', 'rename', { request: { sessionId, title: 'dsh-agent-llm · 三 Agent 模型连通性验证' } }).catch(() => undefined);
  } catch {}

  const only = typeof process.env.ONLY === 'string' && process.env.ONLY.length > 0 ? new Set(process.env.ONLY.split(',')) : undefined;
  const targets = only ? TARGETS.filter((target) => only.has(target.provider)) : TARGETS;
  const results = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const turnNumber = index + 1;
    try {
      const selected = await retry(
        () => rpc('session', 'selectModel', { request: { sessionId, provider: target.provider, model: target.model } }),
        { what: 'selectModel' },
      );
      console.log(`\n[${target.label}] selected`, JSON.stringify(selected.selected));
      await retry(
        () =>
          rpc('session', 'prompt', {
            request: {
              requestId: uuid(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: `只回复这一串字符，不要调用工具：${target.label.replace(/\s+/g, '')}-OK` }],
              clientTimeZone: 'Asia/Shanghai',
            },
          }),
        { what: 'prompt', attempts: 3 },
      );
      const settled = await waitForTurn(sessionId, turnNumber);
      const used = settled.selection && settled.selection.lastUsed;
      const reply = (settled.turn.response || '').trim();
      const ok = used && used.provider === target.provider && used.model === target.model && reply.length > 0;
      console.log(`  used: ${used ? `${used.provider}/${used.model}` : '(unknown)'}`);
      console.log(`  reply: ${JSON.stringify(reply.slice(0, 120))}`);
      if (!ok) {
        const failure = lastAttemptError(sessionId);
        if (failure) console.log(`  provider failure: ${failure.slice(0, 300)}`);
      }
      console.log(`  ${ok ? 'PASS' : 'FAIL'}`);
      results.push({ target, used, reply: reply.slice(0, 300), ok });
    } catch (error) {
      console.log(`\n[${target.label}] ERROR ${error && error.message ? error.message : error}`);
      results.push({ target, ok: false, error: String(error && error.message ? error.message : error) });
    }
  }

  const output = { sessionId, at: new Date().toISOString(), results };
  console.log('\nRESULT', JSON.stringify(output));
  if (results.some((entry) => !entry.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error('E2E ERROR:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
