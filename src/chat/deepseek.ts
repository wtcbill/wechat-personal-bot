/**
 * L3 — DeepSeek Chat Completions and Search/Fetch adapters.
 * Input: injected API key/model, per-call thinking mode, requests and cancellation.
 * Output: validated chat/search records or safe ChatError codes.
 * Pos: chat provider boundary; see ./L2.md.
 * Effects/Dependencies: HTTPS only to api.deepseek.com, bounded retries/body;
 * no logs, persistence, SDK, channel imports or direct fetches of target websites.
 */
import { setTimeout as delay } from "node:timers/promises";
import { ChatError, isRecord, webUrl } from "./types.ts";
import type { ChatModel, ModelReply, ModelRequest, SearchHit, SearchProvider, ToolCall } from "./types.ts";

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  requestTimeoutMs?: number;
  thinkingTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}
export class DeepSeekClient implements ChatModel, SearchProvider {
  private readonly options: Required<DeepSeekOptions>;
  constructor(options: DeepSeekOptions) {
    this.options = { model: "deepseek-flash", requestTimeoutMs: 25_000, thinkingTimeoutMs: 60_000, maxRetries: 1,
      retryDelayMs: 500, fetch: globalThis.fetch, ...options };
    if (!this.options.apiKey.trim()) throw new ChatError("MISSING_API_KEY");
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(this.options.model)) throw new ChatError("INVALID_MODEL");
    for (const [value, min, max] of [[this.options.requestTimeoutMs, 1, 120_000],
      [this.options.thinkingTimeoutMs, 1, 120_000],
      [this.options.maxRetries, 0, 2], [this.options.retryDelayMs, 0, 5000]]) {
      if (value === undefined || min === undefined || max === undefined || !Number.isInteger(value) || value < min || value > max) {
        throw new ChatError("INVALID_CLIENT_OPTIONS");
      }
    }
  }

  private async post(path: string, body: unknown, signal: AbortSignal,
    timeoutMs: number = this.options.requestTimeoutMs): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const response = await this.options.fetch(`https://api.deepseek.com${path}`, {
          method: "POST", redirect: "error", signal: requestSignal,
          headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new ChatError(`HTTP_${response.status}`, [408, 429].includes(response.status) || response.status >= 500);
        }
        if (!response.body) throw new ChatError("INVALID_RESPONSE");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 2_000_000) throw new ChatError("RESPONSE_TOO_LARGE");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        let data: unknown;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
        catch { throw new ChatError("INVALID_RESPONSE"); }
        if (!isRecord(data)) throw new ChatError("INVALID_RESPONSE");
        return data;
      } catch (error) {
        if (signal.aborted) throw new ChatError("CANCELLED");
        const failure = error instanceof ChatError ? error :
          new ChatError(requestSignal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", true);
        if (!failure.retryable || attempt >= this.options.maxRetries) throw failure;
        try { await delay(this.options.retryDelayMs * 2 ** attempt, undefined, { signal }); }
        catch { throw new ChatError("CANCELLED"); }
      }
    }
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    if (!["enabled", "disabled"].includes(request.thinking)) throw new ChatError("INVALID_THINKING_MODE");
    const raw = await this.post("/chat/completions", {
      model: this.options.model, messages: request.messages, stream: false,
      thinking: { type: request.thinking }, max_tokens: request.maxTokens,
      ...(request.thinking === "enabled" ? { reasoning_effort: "high" } : {}),
      ...(request.tools.length ? { tools: request.tools, tool_choice: "auto" } : { tool_choice: "none" }),
    }, signal, request.thinking === "enabled" ? this.options.thinkingTimeoutMs : this.options.requestTimeoutMs);
    const choice = Array.isArray(raw.choices) ? raw.choices[0] as unknown : undefined;
    if (!isRecord(choice) || !isRecord(choice.message)) throw new ChatError("INVALID_CHAT_RESPONSE");
    const message = choice.message;
    if (message.role !== "assistant" || (message.content !== null && typeof message.content !== "string")) {
      throw new ChatError("INVALID_CHAT_RESPONSE");
    }
    const calls: ToolCall[] = [];
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw new ChatError("INVALID_TOOL_CALLS");
      for (const call of message.tool_calls) {
        if (!isRecord(call) || typeof call.id !== "string" || !call.id || call.id.length > 200 ||
          call.type !== "function" || !isRecord(call.function) || typeof call.function.name !== "string" ||
          typeof call.function.arguments !== "string" || call.function.arguments.length > 10_000 ||
          calls.some(item => item.id === call.id)) throw new ChatError("INVALID_TOOL_CALLS");
        calls.push({ id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } });
      }
    }
    const finish = choice.finish_reason;
    if (!["stop", "tool_calls", "length"].includes(String(finish)) || (finish === "tool_calls" && !calls.length)) {
      throw new ChatError("INVALID_FINISH_REASON");
    }
    return {
      message: { role: "assistant", content: message.content,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}) },
      finishReason: finish as ModelReply["finishReason"],
    };
  }

  async search(query: string, question: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
    if (!query.trim() || [...query].length > 128 || !Number.isInteger(count) || count < 1 || count > 50) {
      throw new ChatError("INVALID_SEARCH_ARGUMENTS");
    }
    const raw = await this.post("/v1/tools/search", { query, count, need_content: false,
      ori_question: [...question].slice(0, 128).join("") }, signal);
    if (!Array.isArray(raw.results)) throw new ChatError("INVALID_SEARCH_RESPONSE");
    return raw.results.slice(0, count).map((item: unknown) => {
      if (!isRecord(item) || typeof item.url !== "string" || typeof item.title !== "string" ||
        typeof item.summary !== "string" || typeof item.snippet !== "string" ||
        (item.date !== null && typeof item.date !== "string")) throw new ChatError("INVALID_SEARCH_RESPONSE");
      const summary = item.summary || item.snippet;
      return { url: webUrl(item.url), title: item.title.slice(0, 500), summary: summary.slice(0, 2000),
        publishedAt: typeof item.date === "string" ? item.date : null, truncated: summary.length > 2000 };
    });
  }

  async fetch(url: string, signal: AbortSignal): Promise<{ title: string; content: string }> {
    const raw = await this.post("/v1/tools/fetch", { url: webUrl(url) }, signal);
    if (typeof raw.title !== "string" || typeof raw.content !== "string" || !raw.content.trim()) {
      throw new ChatError("EMPTY_SOURCE");
    }
    return { title: raw.title.slice(0, 500), content: raw.content };
  }
}
