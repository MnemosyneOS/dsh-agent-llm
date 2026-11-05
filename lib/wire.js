/**
 * Message, tool and SSE helpers shared by every dsh-agent-llm connector.
 *
 * The Host half only depends on Node built-ins and on the public
 * `ctx.llm.registerAdapter()` seam, so a Harness upgrade cannot break the
 * bridge as long as that seam keeps its documented shape.
 */

/** Join every text block of one DSH message into one string. */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * Inline one image block into an OpenAI `image_url` content part.
 *
 * Reads the normalized attachment bytes through the Harness attachment service
 * (`readImageRequest`) and base64-encodes them — the bridged WorkBuddy /
 * Hermes gateways accept the data-URI form, exactly like the official
 * desktop agents do when they send a screenshot. `attachments` is the service
 * resolved by the adapter/connector; when it is missing the block is skipped
 * rather than silently dropped without explanation.
 */
async function imagePartOf(block, attachments, signal) {
  const ref = block && block.type === 'image' && block.attachment;
  if (!ref) return undefined;
  if (typeof attachments?.readImageRequest !== 'function') {
    const error = new Error('dsh-agent-llm image input requires the Harness attachment service');
    error.code = 'ATTACHMENT_SERVICE_UNAVAILABLE';
    throw error;
  }
  /* 用 ref 自身尺寸构造 target：readRequestImageFile 在 target 不小于源图时
     直接透传原图字节（dsh-attachment-local L803），无需重新缩放。 */
  const target = {
    width: Number.isInteger(ref.width) && ref.width > 0 ? ref.width : 20 * 1024,
    height: Number.isInteger(ref.height) && ref.height > 0 ? ref.height : 20 * 1024,
    maxBytes: Number.isInteger(ref.bytes) && ref.bytes > 0 ? ref.bytes : 20 * 1024 * 1024,
  };
  const result = await attachments.readImageRequest(ref, target, signal);
  if (!result || !result.data) return undefined;
  const mediaType = typeof result.mediaType === 'string' && result.mediaType.length > 0 ? result.mediaType : 'image/png';
  const base64 = Buffer.from(result.data).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } };
}

/**
 * Convert DSH conversation messages into OpenAI Chat Completions messages.
 *
 * `developer` messages only carry tool-addition/tool-removal records; this
 * adapter always declares the complete active tool list per request, so they
 * are skipped. Reasoning blocks are provider-private and are not sent back.
 *
 * Image blocks on `user` messages are inlined as base64 `image_url` parts when
 * an attachment service is supplied (and the model's `inputModalities` admits
 * images — the capability gate upstream already enforced that). A user turn
 * that mixes text and images becomes a multipart `content` array; a
 * text-only turn keeps the simpler string `content` for maximum backend
 * compatibility.
 *
 * Pairing hygiene: a strict backend (the Anthropic-format gateways behind the
 * bridged agents) rejects a `tool_use` block whose `tool_result` never
 * follows — for example a turn aborted between the assistant's tool-call block
 * and the tool result, which leaves an orphaned call in the session history.
 * Such orphans are dropped on both sides instead of forwarding a conversation
 * the backend refuses outright.
 *
 * @param {Array<object>} messages
 * @param {object} [attachments] Harness attachment service (readImageRequest).
 * @param {AbortSignal} [signal]
 */
export async function toOpenAiMessages(messages, attachments, signal) {
  /** @type {Array<{kind: 'system'|'user'|'assistant'|'tool', entry?: object, text?: string, toolCalls?: object[], callId?: string, isError?: boolean, content?: any, images?: Array<object>}>} */
  const staged = [];
  for (const message of messages ?? []) {
    const role = message && message.role;
    if (role === 'system') {
      const text = textOf(message.content);
      if (text.length > 0) staged.push({ kind: 'system', entry: { role: 'system', content: text } });
      continue;
    }
    if (role === 'developer') continue;
    if (role === 'user') {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = textOf(content);
      const contentParts = [];
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.length > 0) contentParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          contentParts.push(imagePartOf(block, attachments, signal));
        }
      }
      /* Promise.all 保留数组顺序，避免把原本在提示词前面的图片移到末尾。 */
      const resolvedParts = (await Promise.all(contentParts)).filter(Boolean);
      const hasImage = resolvedParts.some((part) => part.type === 'image_url');
      /* 纯文本 → 保持字符串 content；含图片/多块 → 多 part 数组。 */
      if (!hasImage && resolvedParts.length <= 1) {
        staged.push({ kind: 'user', entry: { role: 'user', content: text } });
      } else {
        staged.push({ kind: 'user', entry: { role: 'user', content: resolvedParts } });
      }
      continue;
    }
    if (role === 'assistant') {
      const text = textOf(message.content);
      const toolCalls = [];
      for (const block of message.content ?? []) {
        if (!block || block.type !== 'tool-call') continue;
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.arguments === 'string' && block.arguments.length > 0 ? block.arguments : '{}',
          },
        });
      }
      staged.push({ kind: 'assistant', text, toolCalls });
      continue;
    }
    if (role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId;
      staged.push({
        kind: 'tool',
        callId: callId === undefined ? '' : String(callId),
        text: textOf(message.content),
        isError: message.isError === true,
      });
    }
  }

  /* A call id counts as satisfied only when a tool result for it appears
     after the declaring assistant message; everything else is an orphan. */
  const declared = new Set();
  const satisfied = new Set();
  for (const item of staged) {
    if (item.kind === 'assistant') {
      for (const call of item.toolCalls) declared.add(call.id);
    } else if (item.kind === 'tool' && item.callId.length > 0 && declared.has(item.callId)) {
      satisfied.add(item.callId);
    }
  }

  const out = [];
  for (const item of staged) {
    if (item.kind === 'assistant') {
      const toolCalls = item.toolCalls.filter((call) => call.id.length > 0 && satisfied.has(call.id));
      if (toolCalls.length === 0 && item.text.length === 0) continue;
      const entry = { role: 'assistant', content: toolCalls.length > 0 && item.text.length === 0 ? null : item.text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    if (item.kind === 'tool') {
      if (item.callId.length === 0 || !satisfied.has(item.callId)) continue;
      out.push({
        role: 'tool',
        tool_call_id: item.callId,
        content: item.isError ? `[tool error] ${item.text}` : item.text,
      });
      continue;
    }
    out.push(item.entry);
  }
  return out;
}

/** Convert DSH tool schemas into OpenAI `tools` entries. */
export function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

/** True when the browser/agent request aborted. */
export function abortError() {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

/**
 * Map an HTTP response failure into a terminal adapter error carrying the
 * stable Harness failure code family (`AUTH`, `RATE_LIMIT`, `QUOTA`, ...).
 */
export function httpError(status, bodyText, { retryAfterMs, label } = {}) {
  const detail = typeof bodyText === 'string' ? bodyText.slice(0, 600) : '';
  const message = `${label ?? 'provider'} HTTP ${status}${detail ? `: ${detail}` : ''}`;
  const error = new Error(message);
  error.status = status;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) error.providerRetryAfterMs = retryAfterMs;
  error.code =
    status === 401 || status === 403
      ? 'AUTH'
      : status === 402
        ? 'QUOTA'
        : status === 429
          ? 'RATE_LIMIT'
          : status === 400 || status === 404 || status === 422
            ? 'INVALID_REQUEST'
            : status >= 500
              ? 'SERVER'
              : 'PROVIDER_ERROR';
  return error;
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * Read a Server-Sent-Events body line by line and yield `{ event, data }`
 * frames. `data` is JSON-parsed when possible, otherwise left as the raw
 * string; `[DONE]` terminates the stream.
 */
export async function* readSse(body, signal) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const flush = function* () {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const raw = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';
    if (raw === '[DONE]') return;
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* Some gateways send plain text frames in data: lines. */
    }
    yield { event: name, data };
  };

  for await (const chunk of body) {
    if (signal?.aborted) throw abortError();
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) {
        yield* flush();
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        let payload = line.slice(5);
        if (payload.startsWith(' ')) payload = payload.slice(1);
        dataLines.push(payload);
        continue;
      }
      /* Unknown field (id:, retry:): ignore. */
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) {
        let payload = line.slice(5);
        if (payload.startsWith(' ')) payload = payload.slice(1);
        dataLines.push(payload);
      }
    }
  }
  yield* flush();
}

/** Fetch JSON with a small, uniform error surface. */
export async function fetchJson(url, init, label) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw httpError(response.status, text, { label });
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(response.status, text, { label: `${label} (invalid JSON)` });
  }
}
