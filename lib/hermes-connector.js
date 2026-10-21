/**
 * Hermes Agent connector.
 *
 * Uses the Nous Portal inference API with the OAuth session Hermes already
 * stores, which is the same account and the same free-tier quota Hermes uses.
 * Every call is a plain OpenAI Chat Completions request carrying the DeepSeek
 * Harness tool definitions, so the Harness agent loop keeps its own tools.
 */

import { loadHermesCatalog, CATALOG_TTL_MS } from './hermes-catalog.js';
import { resolveHermesSession, rereadHermesSession, hermesHomeFromEnv, setDiscoveredHermesHome } from './hermes-auth.js';
import { toOpenAiMessages, toOpenAiTools, readSse, httpError, abortError } from './wire.js';

function mapFinish(reason, sawToolCall) {
  switch (reason) {
    case 'stop':
      return sawToolCall ? 'tool-calls' : 'stop';
    case 'length':
      return 'max-tokens';
    case 'tool_calls':
    case 'tool-call':
      return 'tool-calls';
    default:
      return sawToolCall ? 'tool-calls' : 'stop';
  }
}

/** @param {{provider: string, displayName: string, home?: string, log?: object}} options */
export function createHermesConnector(options) {
  const provider = options.provider;
  const displayName = options.displayName;
  const home = hermesHomeFromEnv(options);
  setDiscoveredHermesHome(home);
  const log = options.log;
  let cached = null;
  let cachedAt = 0;

  async function catalog() {
    if (cached && Date.now() - cachedAt < CATALOG_TTL_MS) return cached;
    cached = await loadHermesCatalog({ home, provider });
    cachedAt = Date.now();
    return cached;
  }

  async function openStream(request, session) {
    const body = {
      model: request.model,
      messages: toOpenAiMessages(request.messages),
      stream: true,
    };
    if (typeof request.system === 'string' && request.system.length > 0) {
      body.messages = [{ role: 'system', content: request.system }, ...body.messages];
    }
    const tools = toOpenAiTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (Number.isFinite(request.maxTokens) && request.maxTokens > 0) body.max_tokens = Math.trunc(request.maxTokens);
    if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) body.temperature = request.temperature;
    if (Array.isArray(request.stop) && request.stop.length > 0) body.stop = request.stop;

    const headers = {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const response = await fetch(`${session.inferenceBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw httpError(response.status, text, { label: displayName });
    }
    return response;
  }

  async function openWithRetry(request) {
    const allowRefresh = options.allowRefresh !== false;
    let session = await resolveHermesSession({ home, log, allowRefresh });
    try {
      return { session, response: await openStream(request, session) };
    } catch (error) {
      if (!error || error.status !== 401) throw error;
      /* Hermes may have rotated the token after we read it. */
      const reread = await rereadHermesSession({ home });
      if (reread && reread.token !== session.token) {
        session = reread;
      } else {
        session = await resolveHermesSession({ home, log, allowRefresh });
      }
      return { session, response: await openStream(request, session) };
    }
  }

  async function* streamEvents(request) {
    const { session, response } = await openWithRetry(request);
    const toolCalls = new Map();
    let finishReason = null;
    let usage = null;
    let sawToolCall = false;
    let cost = null;

    const closeTools = function* () {
      for (const call of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
        if (!call.started) continue;
        yield {
          type: 'tool-call-end',
          toolIndex: call.index,
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
      }
      toolCalls.clear();
    };

    for await (const frame of readSse(response.body, request.signal)) {
      const payload = frame.data;
      if (payload === null || typeof payload !== 'object') continue;
      if (payload.done === true) break;
      if (payload.error) {
        const detail = payload.error;
        const error = new Error(
          typeof detail === 'string' ? detail : detail.message ?? `${displayName} 返回错误`,
        );
        error.code = detail.code === 'rate_limit' ? 'RATE_LIMIT' : 'PROVIDER_ERROR';
        throw error;
      }
      if (payload.usage && typeof payload.usage === 'object') {
        usage = {
          inputTokens: Number(payload.usage.prompt_tokens ?? 0),
          outputTokens: Number(payload.usage.completion_tokens ?? 0),
          totalTokens: Number(payload.usage.total_tokens ?? 0),
          cacheReadTokens: Number(
            payload.usage.prompt_tokens_details?.cached_tokens ?? payload.usage.cache_read_input_tokens ?? 0,
          ),
          reasoningTokens: Number(payload.usage.completion_tokens_details?.reasoning_tokens ?? 0),
        };
        if (Number.isFinite(Number(payload.usage.cost))) cost = Number(payload.usage.cost);
      }
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        yield { type: 'reasoning', text: delta.reasoning_content };
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const index = Number.isInteger(toolCall.index) ? toolCall.index : 0;
          let state = toolCalls.get(index);
          if (!state) {
            state = { index, id: '', name: '', arguments: '', started: false };
            toolCalls.set(index, state);
          }
          if (typeof toolCall.id === 'string' && toolCall.id.length > 0) state.id = toolCall.id;
          const fn = toolCall.function ?? {};
          if (typeof fn.name === 'string' && fn.name.length > 0) state.name = fn.name;
          if (!state.started && state.name.length > 0) {
            state.started = true;
            sawToolCall = true;
            yield { type: 'tool-call-start', toolIndex: index, id: state.id, name: state.name };
          }
          if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
            if (!state.started) {
              state.started = true;
              sawToolCall = true;
              yield { type: 'tool-call-start', toolIndex: index, id: state.id, name: state.name };
            }
            state.arguments += fn.arguments;
            yield { type: 'tool-call-delta', toolIndex: index, argumentsDelta: fn.arguments };
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== '') {
        finishReason = choice.finish_reason;
      }
    }

    yield* closeTools();
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0,
        outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
        totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0,
        cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
        reasoningTokens: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0,
      };
      if (cost !== null && cost > 0) {
        log?.info?.(`dsh-agent-llm: ${displayName} ${request.model} 本次消耗 $${cost}`);
      }
    }
    yield { type: 'finish', reason: mapFinish(finishReason, sawToolCall) };
    void session;
  }

  return {
    provider,
    displayName,
    home,

    async listModels() {
      const loaded = await catalog();
      return loaded.models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        inputModalities: model.inputModalities,
      }));
    },

    async resolveModel(modelId) {
      const loaded = await catalog();
      const model = loaded.models.find((entry) => entry.id === modelId);
      if (!model) {
        /* Saved selections may predate a catalog change; keep the exact id routable. */
        return {
          provider,
          id: modelId,
          name: modelId,
          description: '来源 Hermes Agent（Nous）：当前模型清单未包含此 id',
          inputModalities: ['text'],
        };
      }
      return {
        provider,
        id: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.context ? { context: model.context } : {}),
        inputModalities: model.inputModalities,
      };
    },

    async *stream(request) {
      if (request.signal?.aborted) throw abortError();
      yield* streamEvents(request);
    },
  };
}
