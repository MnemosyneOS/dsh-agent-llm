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
 * Convert DSH conversation messages into OpenAI Chat Completions messages.
 *
 * `developer` messages only carry tool-addition/tool-removal records; this
 * adapter always declares the complete active tool list per request, so they
 * are skipped. Reasoning blocks are provider-private and are not sent back.
 */
export function toOpenAiMessages(messages) {
  const out = [];
  for (const message of messages ?? []) {
    const role = message && message.role;
    if (role === 'system') {
      const text = textOf(message.content);
      if (text.length > 0) out.push({ role: 'system', content: text });
      continue;
    }
    if (role === 'developer') continue;
    if (role === 'user') {
      out.push({ role: 'user', content: textOf(message.content) });
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
      const entry = { role: 'assistant', content: toolCalls.length > 0 && text.length === 0 ? null : text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    if (role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId;
      const text = textOf(message.content);
      out.push({
        role: 'tool',
        tool_call_id: callId === undefined ? '' : String(callId),
        content: message.isError === true ? `[tool error] ${text}` : text,
      });
    }
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
