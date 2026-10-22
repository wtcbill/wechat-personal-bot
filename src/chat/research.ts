/**
 * L3 — Bounded search/read/find execution and source evidence.
 * Input: model function calls, provider port, current question and network policy.
 * Output: paired JSON tool results, source snapshots and safe execution records.
 * Pos: chat research tools; see ./L2.md.
 * Effects/Dependencies: provider Search/Fetch I/O; bounded memory; find is literal
 * local matching. Prior-turn metadata is registered but never fresh evidence.
 */
import type { AnswerSource } from "../services.ts";
import { ChatError, isRecord, webUrl } from "./types.ts";
import type { SearchHit, SearchProvider, ToolCall, ToolDefinition } from "./types.ts";

export const TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "search_web", description: "搜索网页。每次最多三个查询，每个查询不超过128个Unicode字符；优先官方来源。",
    parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } }, required: ["queries"], additionalProperties: false } } },
  { type: "function", function: { name: "read_source", description: "按已登记来源ID读取网页正文；长文可用offset继续阅读，或用find_in_source定位。offset单位为JavaScript字符。",
    parameters: { type: "object", properties: { source_id: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["source_id"], additionalProperties: false } } },
  { type: "function", function: { name: "find_in_source", description: "在本轮已读取的正文缓存中查找字面文本，返回位置与上下文；不支持正则表达式，不联网。",
    parameters: { type: "object", properties: { source_id: { type: "string" }, pattern: { type: "string" } }, required: ["source_id", "pattern"], additionalProperties: false } } },
];
interface Source extends AnswerSource { body: string | null }
export interface ResearchLimits { maxTools: number; maxSearches: number; maxFetches: number; maxSources: number }
export interface ToolRecord { id: string; name: string; status: string }

export class Research {
  private readonly records = new Map<string, Source>();
  private readonly byUrl = new Map<string, string>();
  readonly trace: ToolRecord[] = [];
  searches = 0;
  fetches = 0;
  calls = 0;
  constructor(privatePort: SearchProvider, question: string, network: boolean, limits: ResearchLimits,
    nextId: () => string, prior: AnswerSource[] = []) {
    this.provider = privatePort;
    this.question = question;
    this.network = network;
    this.limits = limits;
    this.nextId = nextId;
    for (const old of prior.slice(-Math.floor(limits.maxSources / 2))) {
      const source = this.register(old.url, old.id);
      if (source) source.title = old.title;
    }
    for (const match of question.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
      try { this.register(match[0].replace(/[.,;!?，。；！？）)\]]+$/, "")); } catch { /* Not a valid source. */ }
    }
  }
  private readonly provider: SearchProvider;
  private readonly question: string;
  private readonly network: boolean;
  private readonly limits: ResearchLimits;
  private readonly nextId: () => string;

  private register(value: string, id?: string): Source | undefined {
    const url = webUrl(value);
    const existing = this.byUrl.get(url);
    if (existing) return this.records.get(existing);
    if (this.records.size >= this.limits.maxSources) return undefined;
    const source: Source = { id: id ?? this.nextId(), url, title: url, publishedAt: null, retrievedAt: null,
      excerpt: "", status: "unread", truncated: false, body: null };
    this.records.set(source.id, source);
    this.byUrl.set(url, source.id);
    return source;
  }
  sources(): AnswerSource[] {
    return [...this.records.values()].map(({ body: _body, ...source }) => ({ ...source }));
  }
  evidence(): AnswerSource[] { return this.sources().filter(source => source.retrievedAt !== null && source.excerpt.trim() && ["summary", "read"].includes(source.status)); }
  catalog(): string { return JSON.stringify(this.sources().map(({ id, url, title, status }) => ({ id, url, title, status }))); }
  private save(hit: SearchHit): Source | undefined {
    const source = this.register(hit.url);
    if (!source) return undefined;
    source.title = hit.title.slice(0, 500);
    source.publishedAt = hit.publishedAt;
    source.retrievedAt = new Date().toISOString();
    if (source.status !== "read") {
      source.status = "summary";
      source.excerpt = hit.summary.slice(0, 2000);
      source.truncated = Boolean(hit.truncated) || hit.summary.length > 2000;
    }
    return source;
  }
  async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    let result: Record<string, unknown>;
    try {
      signal.throwIfAborted();
      if (++this.calls > this.limits.maxTools) throw new ChatError("TOOL_BUDGET");
      let args: unknown;
      try { args = JSON.parse(call.function.arguments) as unknown; } catch { throw new ChatError("INVALID_ARGUMENTS"); }
      if (!isRecord(args)) throw new ChatError("INVALID_ARGUMENTS");
      const name = call.function.name;
      if (name === "search_web") {
        if (!this.network) throw new ChatError("NETWORK_DISABLED");
        if (Object.keys(args).some(key => key !== "queries") || !Array.isArray(args.queries) ||
          args.queries.length < 1 || args.queries.length > 3 || args.queries.some(query =>
            typeof query !== "string" || !query.trim() || [...query].length > 128)) throw new ChatError("INVALID_ARGUMENTS");
        const queries = [...new Set(args.queries as string[])];
        // Validate the entire batch before issuing any request.
        if (this.searches + queries.length > this.limits.maxSearches) throw new ChatError("SEARCH_BUDGET");
        const found = new Map<string, AnswerSource>();
        const errors: string[] = [];
        for (const query of queries) {
          signal.throwIfAborted();
          this.searches++;
          try {
            const hits = await this.provider.search(query, this.question, 5, signal);
            signal.throwIfAborted();
            for (const hit of hits.slice(0, 5)) {
              const source = this.save(hit);
              if (source) found.set(source.id, source);
            }
          } catch (error) {
            if (signal.aborted) throw error;
            errors.push(error instanceof ChatError ? error.code : "SEARCH_FAILED");
          }
        }
        result = { ok: errors.length === 0, sources: [...found.values()].map(source => ({
          id: source.id, url: source.url, title: source.title, publishedAt: source.publishedAt,
          retrievedAt: source.retrievedAt, summary: source.excerpt.slice(0, 600), status: source.status,
          summaryTruncated: source.truncated || source.excerpt.length > 600,
        })), errors, empty: found.size === 0, sourceLimitReached: this.records.size >= this.limits.maxSources };
      } else if (name === "read_source" || name === "find_in_source") {
        const allowed = name === "read_source" ? ["source_id", "offset"] : ["source_id", "pattern"];
        if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.source_id !== "string") throw new ChatError("INVALID_ARGUMENTS");
        const source = this.records.get(args.source_id);
        if (!source) throw new ChatError("UNKNOWN_SOURCE");
        if (name === "read_source") {
          const offset = args.offset ?? 0;
          if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new ChatError("INVALID_ARGUMENTS");
          if (!this.network) throw new ChatError("NETWORK_DISABLED");
          if (source.body === null) {
            if (this.fetches >= this.limits.maxFetches) throw new ChatError("FETCH_BUDGET");
            this.fetches++;
            try {
              const page = await this.provider.fetch(source.url, signal);
              signal.throwIfAborted();
              if (!page.content.trim()) throw new ChatError("EMPTY_SOURCE");
              source.body = page.content.slice(0, 40_000);
              source.truncated = page.content.length > source.body.length;
              source.title = page.title || source.title;
              source.status = "read";
              source.retrievedAt = new Date().toISOString();
              source.excerpt = source.body.slice(0, 2000);
            } catch (error) {
              if (source.status !== "summary") source.status = "failed";
              throw error;
            }
          }
          result = { ok: true, source_id: source.id, title: source.title, url: source.url,
            content: source.body.slice(offset, offset + 8000), offset, cachedLength: source.body.length,
            nextOffset: offset + 8000 < source.body.length ? offset + 8000 : null,
            truncated: source.truncated || offset + 8000 < source.body.length, retrievedAt: source.retrievedAt };
        } else {
          if (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 200) throw new ChatError("INVALID_ARGUMENTS");
          if (source.body === null) throw new ChatError("READ_SOURCE_FIRST");
          const matches: { offset: number; text: string }[] = [];
          let start = 0;
          while (matches.length < 5) {
            const index = source.body.indexOf(args.pattern, start);
            if (index < 0) break;
            matches.push({ offset: index, text: source.body.slice(Math.max(0, index - 160), index + args.pattern.length + 160) });
            start = index + args.pattern.length;
          }
          result = { ok: true, source_id: source.id, matches, scope: "cached_body", truncated: source.truncated,
            note: source.truncated ? "仅查找缓存正文；未匹配不代表原网页没有该内容。" : "" };
        }
      } else throw new ChatError("UNKNOWN_TOOL");
    } catch (error) {
      if (signal.aborted) throw error;
      result = { ok: false, error: error instanceof ChatError ? error.code : "TOOL_FAILED" };
    }
    const status = result.ok ? "ok" : typeof result.error === "string" ? result.error : "PARTIAL_SEARCH";
    this.trace.push({ id: call.id, name: call.function.name, status });
    return JSON.stringify({ ...result, remaining: { tools: Math.max(0, this.limits.maxTools - this.calls),
      searches: this.limits.maxSearches - this.searches, fetches: this.limits.maxFetches - this.fetches } });
  }
}
