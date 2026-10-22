/**
 * WorkBuddy / WorkBuddy AI login reuse.
 *
 * Both desktop agents store the OAuth session in the shared CodeBuddy auth
 * store (`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`). The
 * token fields are sealed with the app's at-rest key, which the installed
 * Electron build can export through its linked binding. This module asks that
 * build (headless, no GUI, no writes) for the key, unwraps the envelope with
 * AES-256-GCM, and keeps the resulting token in memory.
 *
 * Nothing is persisted: the user signs in to the agent once, and this bridge
 * keeps reading that same session for as long as it stays valid.
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createDecipheriv, createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const AAD_PREFIX = Buffer.from('WB-AAD\0', 'ascii');
const FRAMING_NAME = 'WBEV1';
const FRAMING_ID = 2; /* 'field' framing */

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function lengthPrefixed(value) {
  const buffer = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(buffer.length), buffer]);
}

function buildAad(keyId, suite, scheme = 'sym-v1') {
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    lengthPrefixed(FRAMING_NAME),
    lengthPrefixed(scheme),
    u32(suite),
    lengthPrefixed(keyId),
    Buffer.from([FRAMING_ID]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function deriveKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** 本进程内缓存的已发现可执行文件（避免每次调用都扫描注册表）。 */
let discoveredExes = null;

export async function setDiscoveredExecutables(paths) {
  discoveredExes = paths.filter((path) => typeof path === 'string' && path.length > 0);
}

/**
 * 可执行文件候选：显式的 row config / 环境变量优先，其后是本机自动发现结果。
 * 同步接口保持不变，首次调用时若尚未发现则回退到常见安装位置。
 */
export function defaultExeCandidates() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const list = [];
  if (process.env.DSH_AGENT_LLM_WORKBUDDY_EXE) list.push(process.env.DSH_AGENT_LLM_WORKBUDDY_EXE);
  if (discoveredExes && discoveredExes.length > 0) list.push(...discoveredExes);
  list.push(
    join(local, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  );
  return [...new Set(list)];
}

/** Shared auth-store directory and per-product file names. */
export function defaultAuthStores() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const dir = join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  return {
    'workbuddy-ai': { file: join(dir, 'workbuddy-desktop-ai.info'), appId: 'workbuddy-ai' },
    workbuddy: { file: join(dir, 'workbuddy-desktop.info'), appId: 'workbuddy' },
  };
}

let protectorPromise = null;

/**
 * Ask the installed Electron build for its at-rest bootstrap payload.
 * @param {string[]} exeCandidates
 * @returns {Promise<{key: Buffer, keyId: string}>}
 */
export async function loadProtectorKey(exeCandidates = defaultExeCandidates()) {
  if (protectorPromise) return protectorPromise;
  protectorPromise = (async () => {
    const outPath = join(tmpdir(), `dsh-agent-llm-wb-${process.pid}-${randomBytes(6).toString('hex')}.json`);
    const helper =
      "const fs=require('node:fs');" +
      "const binding=process._linkedBinding('electron_browser_workbuddy_storage');" +
      "fs.writeFileSync(process.env.DSH_AGENT_LLM_KEY_OUT, binding.loggerGet(), { mode: 0o600 });";
    let lastError = null;
    for (const exe of exeCandidates) {
      try {
        await spawnHelper(exe, helper, outPath);
        const raw = await readFile(outPath, 'utf8');
        const payload = JSON.parse(raw);
        if (!payload || typeof payload.atRestSecretKey !== 'string' || payload.atRestSecretKey.length === 0) {
          throw new Error('at-rest bootstrap payload has no atRestSecretKey');
        }
        const key = createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
        return { key, keyId: deriveKeyId(key) };
      } catch (error) {
        lastError = error;
      } finally {
        try {
          await unlink(outPath);
        } catch {
          /* The helper may not have created the file. */
        }
      }
    }
    protectorPromise = null;
    const error = new Error(
      `无法读取 WorkBuddy 的本地加密密钥：${lastError && lastError.message ? lastError.message : '未找到可用的 WorkBuddy 可执行文件'}。请先打开一次 WorkBuddy AI 或 WorkBuddy 完成登录。`,
    );
    error.code = 'AUTH';
    throw error;
  })();
  return protectorPromise;
}

function spawnHelper(exe, helper, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-e', helper], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_AGENT_LLM_KEY_OUT: outPath },
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('读取 WorkBuddy 密钥超时'));
    }, 25000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function openEnvelope(protector, envelope) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    protector.key,
    Buffer.from(envelope.nonce, 'base64'),
    { authTagLength: 16 },
  );
  decipher.setAAD(buildAad(envelope.keyId ?? protector.keyId, envelope.suite));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
}

/** Decrypt one `$wbEncrypted` field wrapper; plain strings pass through. */
export function decryptField(protector, wrapper) {
  if (typeof wrapper === 'string') return wrapper;
  if (!wrapper || wrapper.$wbEncrypted !== 1 || typeof wrapper.envelope !== 'string') {
    throw new Error('unexpected WorkBuddy auth field shape');
  }
  const envelope = JSON.parse(Buffer.from(wrapper.envelope, 'base64').toString('utf8'));
  return openEnvelope(protector, envelope).toString('utf8');
}

const tokenCache = new Map();

function jwtExpiry(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the signed-in session for one product, decrypting it on first use.
 * @param {string} providerKey `workbuddy-ai` | `workbuddy`
 * @param {{authStores?: object, exeCandidates?: string[], force?: boolean}} [options]
 */
export async function resolveWorkBuddySession(providerKey, options = {}) {
  const stores = options.authStores ?? defaultAuthStores();
  const store = stores[providerKey];
  if (!store) throw new Error(`unknown WorkBuddy product ${providerKey}`);
  const cached = tokenCache.get(providerKey);
  const now = Date.now();
  if (!options.force && cached && cached.expiresAt - 60_000 > now) return cached;

  const raw = JSON.parse(await readFile(store.file, 'utf8'));
  const auth = raw.auth ?? {};
  const protector = await loadProtectorKey(options.exeCandidates);
  const accessToken = decryptField(protector, auth.accessToken);
  const refreshToken = auth.refreshToken ? decryptField(protector, auth.refreshToken) : null;
  const expiresAt =
    Number.isFinite(auth.expiresAt) && auth.expiresAt > 0 ? auth.expiresAt : jwtExpiry(accessToken) ?? now + 60 * 60 * 1000;
  const session = {
    accessToken,
    refreshToken,
    expiresAt,
    domain: typeof auth.domain === 'string' ? auth.domain : undefined,
    account: raw.account ?? {},
    appId: store.appId,
  };
  tokenCache.set(providerKey, session);
  return session;
}

/** Drop the cached session so the next request re-reads the auth store. */
export function invalidateWorkBuddySession(providerKey) {
  tokenCache.delete(providerKey);
}

/** Build the header set the official WorkBuddy desktop client sends. */
export function buildWorkBuddyHeaders({ session, appVersion, trace = true }) {
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-User-Id': String(session.account?.uid ?? ''),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': appVersion,
    'X-Private-Data': 'true',
    'User-Agent': `WorkBuddy/${appVersion} WorkBuddy/${appVersion}`,
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'X-Request-ID': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
  };
  if (session.domain) headers['X-Domain'] = session.domain;
  if (trace) {
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const parentId = randomBytes(8).toString('hex');
    headers.traceparent = `00-${traceId}-${spanId}-01`;
    headers.b3 = `${traceId}-${spanId}-1-${parentId}`;
    headers['X-B3-TraceId'] = traceId;
    headers['X-B3-ParentSpanId'] = parentId;
    headers['X-B3-SpanId'] = spanId;
    headers['X-B3-Sampled'] = '1';
    headers['X-Trace-ID'] = traceId;
  }
  return headers;
}
