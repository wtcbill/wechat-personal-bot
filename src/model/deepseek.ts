/**
 * L3 — Shared DeepSeek HTTP/completion adapter.
 * Input: independently configured key/model, normalized requests and cancellation.
 * Output: validated completion replies or safe ModelError codes.
 * Pos: shared provider transport; see ./L2.md.
 * Effects/Dependencies: bounded HTTPS to api.deepseek.com only; no business state,
 * file writes, logging or environment reads. Calls happen only on invocation.
 */
import { setTimeout as delay } from "node:timers/promises";
import { ModelError, isRecord } from "./types.ts";
import type { LanguageModel, ModelReply, ModelRequest, ToolCall } from "./types.ts";

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  requestTimeoutMs?: number;
  thinkingTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}
export class DeepSeekModel implements LanguageModel {
  private readonly options: Required<DeepSeekOptions>;
  constructor(options: DeepSeekOptions) {
    this.options = { model: "deepseek-flash", requestTimeoutMs: 25_000, thinkingTimeoutMs: 60_000, maxRetries: 1,
      retryDelayMs: 500, fetch: globalThis.fetch, ...options };
    if (!this.options.apiKey.trim()) throw new ModelError("MISSING_API_KEY");
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(this.options.model)) throw new ModelError("INVALID_MODEL");
    for (const [value, min, max] of [[this.options.requestTimeoutMs, 1, 120_000],
      [this.options.thinkingTimeoutMs, 1, 120_000],
      [this.options.maxRetries, 0, 2], [this.options.retryDelayMs, 0, 5000]]) {
      if (value === undefined || min === undefined || max === undefined || !Number.isInteger(value) || value < min || value > max) {
        throw new ModelError("INVALID_CLIENT_OPTIONS");
      }
    }
  }

  async post(path: "/chat/completions" | "/v1/tools/search" | "/v1/tools/fetch", body: unknown, signal: AbortSignal,
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
          throw new ModelError(`HTTP_${response.status}`, [408, 429].includes(response.status) || response.status >= 500);
        }
        if (!response.body) throw new ModelError("INVALID_RESPONSE");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 2_000_000) throw new ModelError("RESPONSE_TOO_LARGE");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        let data: unknown;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
        catch { throw new ModelError("INVALID_RESPONSE"); }
        if (!isRecord(data)) throw new ModelError("INVALID_RESPONSE");
        return data;
      } catch (error) {
        if (signal.aborted) throw new ModelError("CANCELLED");
        const failure = error instanceof ModelError ? error :
          new ModelError(requestSignal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", true);
        if (!failure.retryable || attempt >= this.options.maxRetries) throw failure;
        try { await delay(this.options.retryDelayMs * 2 ** attempt, undefined, { signal }); }
        catch { throw new ModelError("CANCELLED"); }
      }
    }
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    if (!["enabled", "disabled"].includes(request.thinking)) throw new ModelError("INVALID_THINKING_MODE");
    const raw = await this.post("/chat/completions", {
      model: this.options.model, messages: request.messages, stream: false,
      thinking: { type: request.thinking }, max_tokens: request.maxTokens,
      ...(request.thinking === "enabled" ? { reasoning_effort: "high" } : {}),
      ...(request.tools.length ? { tools: request.tools, tool_choice: "auto" } : { tool_choice: "none" }),
    }, signal, request.thinking === "enabled" ? this.options.thinkingTimeoutMs : this.options.requestTimeoutMs);
    const choice = Array.isArray(raw.choices) ? raw.choices[0] as unknown : undefined;
    if (!isRecord(choice) || !isRecord(choice.message)) throw new ModelError("INVALID_CHAT_RESPONSE");
    const message = choice.message;
    if (message.role !== "assistant" || (message.content !== null && typeof message.content !== "string")) {
      throw new ModelError("INVALID_CHAT_RESPONSE");
    }
    const calls: ToolCall[] = [];
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw new ModelError("INVALID_TOOL_CALLS");
      for (const call of message.tool_calls) {
        if (!isRecord(call) || typeof call.id !== "string" || !call.id || call.id.length > 200 ||
          call.type !== "function" || !isRecord(call.function) || typeof call.function.name !== "string" ||
          typeof call.function.arguments !== "string" || call.function.arguments.length > 10_000 ||
          calls.some(item => item.id === call.id)) throw new ModelError("INVALID_TOOL_CALLS");
        calls.push({ id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } });
      }
    }
    const finish = choice.finish_reason;
    if (!["stop", "tool_calls", "length"].includes(String(finish)) || (finish === "tool_calls" && !calls.length)) {
      throw new ModelError("INVALID_FINISH_REASON");
    }
    return {
      message: { role: "assistant", content: message.content,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}) },
      finishReason: finish as ModelReply["finishReason"],
    };
  }

}
