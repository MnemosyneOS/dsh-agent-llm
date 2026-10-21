/**
 * The DSH LLM adapter shared by every bridged agent.
 *
 * This file intentionally imports nothing from `@deepseek-ai/*`: the adapter
 * is a plain object implementing the documented `LlmAdapter` surface
 * (`providerInfo`, `listModels`, `resolveModel`, `prepareCall`, `stream`), so
 * the plugin needs no dependency on Harness internals and keeps working when
 * packaged Harness packages are upgraded.
 */

/**
 * @typedef {Object} Connector
 * @property {string} provider DSH provider route id.
 * @property {string} displayName Human-readable provider name.
 * @property {(signal?: AbortSignal) => Promise<Array<object>>} listModels
 * @property {(model: string, signal?: AbortSignal) => Promise<object>} resolveModel
 * @property {(request: object) => AsyncIterable<object>} stream Normalized events.
 */

export class AgentLlmAdapter {
  /** @param {Connector[]} connectors @param {{log?: object}} [options] */
  constructor(connectors, options = {}) {
    this.connectors = new Map(connectors.map((connector) => [connector.provider, connector]));
    this.log = options.log;
  }

  connectorOf(provider) {
    const connector = this.connectors.get(provider);
    if (!connector) {
      const error = new Error(`no dsh-agent-llm connector registered for provider "${provider}"`);
      error.code = 'NO_ADAPTER';
      throw error;
    }
    return connector;
  }

  providerInfo(provider) {
    return { id: provider, name: this.connectorOf(provider).displayName };
  }

  /* Optional adapter surfaces: the documented defaults are reproduced here
     because this is a plain object rather than a subclass of LlmAdapter. */
  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async listModels(provider) {
    return this.connectorOf(provider).listModels();
  }

  async resolveModel(provider, model, signal) {
    return this.connectorOf(provider).resolveModel(model, signal);
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(options) {
    const connector = this.connectorOf(options.provider);
    const events = connector.stream({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: options.stop,
      reasoningEffort: options.reasoningEffort,
      purpose: options.purpose,
      signal: options.signal,
    });

    let closed = false;
    /** @type {{kind: 'text'|'reasoning', index: number, text: string}|null} */
    let current = null;
    let nextIndex = 0;
    let usage = null;
    let sawToolCall = false;
    /** @type {Map<number, {index: number, id: string, name: string, arguments: string}>} */
    const toolCalls = new Map();

    function* closeCurrent() {
      if (!current) return;
      yield {
        type: 'block-end',
        index: current.index,
        block: current.kind === 'text' ? { type: 'text', text: current.text } : { type: 'reasoning', text: current.text },
      };
      current = null;
    }

    function* closeTools() {
      for (const call of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
        yield {
          type: 'block-end',
          index: call.index,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
        };
      }
      toolCalls.clear();
    }

    try {
      for await (const event of events) {
        if (options.signal?.aborted) {
          const error = new Error('request aborted');
          error.code = 'ABORTED';
          throw error;
        }
        switch (event?.type) {
          case 'text': {
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.length === 0) break;
            if (!current || current.kind !== 'text') {
              yield* closeCurrent();
              current = { kind: 'text', index: nextIndex++, text: '' };
              yield { type: 'block-start', index: current.index, blockType: 'text' };
            }
            current.text += text;
            yield { type: 'text-delta', index: current.index, text };
            break;
          }
          case 'reasoning': {
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.length === 0) break;
            if (!current || current.kind !== 'reasoning') {
              yield* closeCurrent();
              current = { kind: 'reasoning', index: nextIndex++, text: '' };
              yield { type: 'block-start', index: current.index, blockType: 'reasoning' };
            }
            current.text += text;
            yield { type: 'reasoning-delta', index: current.index, text };
            break;
          }
          case 'tool-call-start': {
            yield* closeCurrent();
            const index = nextIndex++;
            const id = typeof event.id === 'string' && event.id.length > 0 ? event.id : `call_${index}`;
            const name = typeof event.name === 'string' ? event.name : '';
            toolCalls.set(event.toolIndex ?? index, { index, id, name, arguments: '' });
            yield { type: 'block-start', index, blockType: 'tool-call' };
            break;
          }
          case 'tool-call-delta': {
            const call = toolCalls.get(event.toolIndex);
            if (!call) break;
            const delta = typeof event.argumentsDelta === 'string' ? event.argumentsDelta : '';
            call.arguments += delta;
            if (typeof event.name === 'string' && event.name.length > 0) call.name = event.name;
            yield {
              type: 'tool-call-delta',
              index: call.index,
              id: call.id,
              ...(call.name.length > 0 ? { name: call.name } : {}),
              argumentsDelta: delta,
            };
            break;
          }
          case 'tool-call-end': {
            const key = event.toolIndex;
            let call = toolCalls.get(key);
            if (!call) {
              const index = nextIndex++;
              call = { index, id: event.id ?? `call_${index}`, name: event.name ?? '', arguments: '' };
              toolCalls.set(key, call);
              yield { type: 'block-start', index, blockType: 'tool-call' };
            }
            if (typeof event.id === 'string' && event.id.length > 0) call.id = event.id;
            if (typeof event.name === 'string' && event.name.length > 0) call.name = event.name;
            if (typeof event.arguments === 'string' && event.arguments.length > 0) call.arguments = event.arguments;
            sawToolCall = true;
            yield* closeCurrent();
            yield {
              type: 'block-end',
              index: call.index,
              block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
            };
            toolCalls.delete(key);
            break;
          }
          case 'usage': {
            const input = Number(event.inputTokens);
            const output = Number(event.outputTokens);
            if (!Number.isFinite(input) || !Number.isFinite(output)) break;
            usage = {
              inputTokens: Math.max(0, Math.trunc(input)),
              outputTokens: Math.max(0, Math.trunc(output)),
            };
            if (Number.isFinite(event.totalTokens)) usage.totalTokens = Math.max(0, Math.trunc(event.totalTokens));
            if (Number.isFinite(event.cacheReadTokens) && event.cacheReadTokens > 0) usage.cacheReadTokens = Math.trunc(event.cacheReadTokens);
            if (Number.isFinite(event.cacheWriteTokens) && event.cacheWriteTokens > 0) usage.cacheWriteTokens = Math.trunc(event.cacheWriteTokens);
            if (Number.isFinite(event.reasoningTokens) && event.reasoningTokens > 0) usage.reasoningTokens = Math.trunc(event.reasoningTokens);
            break;
          }
          case 'finish': {
            yield* closeCurrent();
            yield* closeTools();
            if (usage) yield { type: 'usage', usage };
            let reason = event.reason;
            if (!reason || reason === 'stop') reason = sawToolCall ? 'tool-calls' : 'stop';
            if (reason !== 'stop' && reason !== 'tool-calls' && reason !== 'max-tokens') reason = 'stop';
            yield { type: 'finish', reason: { kind: reason } };
            closed = true;
            return;
          }
          case 'error': {
            const error = new Error(typeof event.message === 'string' ? event.message : 'provider stream failed');
            if (typeof event.code === 'string') error.code = event.code;
            if (typeof event.status === 'number') error.status = event.status;
            throw error;
          }
          default:
            break;
        }
      }
    } finally {
      /* Client cancellation closes the underlying fetch through its own signal. */
    }

    if (!closed) {
      yield* closeCurrent();
      yield* closeTools();
      if (usage) yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
