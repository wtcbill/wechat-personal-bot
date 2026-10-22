/**
 * L3 — Chat-owned DeepSeek search/fetch and completion error boundary.
 * Input: injected configuration, model requests and search/fetch arguments.
 * Output: normalized chat records or safe ChatError codes.
 * Pos: chat provider adapter; see ./L2.md.
 * Effects/Dependencies: delegates HTTP/completions to shared model transport;
 * Search/Fetch remain chat-owned. No environment reads, logging or persistence.
 */
import { DeepSeekModel } from "../model/deepseek.ts";
import type { DeepSeekOptions } from "../model/deepseek.ts";
import { ModelError } from "../model/types.ts";
import { ChatError, isRecord, webUrl } from "./types.ts";
import type { ChatModel, ModelReply, ModelRequest, SearchHit, SearchProvider } from "./types.ts";
export type { DeepSeekOptions } from "../model/deepseek.ts";

export class DeepSeekClient implements ChatModel, SearchProvider {
  private readonly model: DeepSeekModel;
  constructor(options: DeepSeekOptions) {
    try { this.model = new DeepSeekModel(options); } catch (error) { throw chatError(error); }
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    try { return await this.model.complete(request, signal); } catch (error) { throw chatError(error); }
  }
  private async post(path: "/v1/tools/search" | "/v1/tools/fetch", body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    try { return await this.model.post(path, body, signal); } catch (error) { throw chatError(error); }
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

function chatError(error: unknown): ChatError {
  return error instanceof ModelError ? new ChatError(error.code, error.retryable) : new ChatError("MODEL_FAILED");
}
