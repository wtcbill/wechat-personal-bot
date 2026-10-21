/**
 * L3 — Chat-owned model/search ports and safe failures.
 * Input/Output: per-call thinking mode, normalized messages, tools and documents.
 * Pos: internal chat contracts; see ./L2.md.
 * Effects/Dependencies: none; ports accept cancellation, no channel dependencies.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
  thinking: "enabled" | "disabled";
  maxTokens: number;
}
export interface ModelReply {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: "stop" | "tool_calls" | "length";
}
export interface ChatModel {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export interface SearchHit {
  url: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  truncated?: boolean;
}
export interface SearchProvider {
  search(query: string, question: string, count: number, signal: AbortSignal): Promise<SearchHit[]>;
  fetch(url: string, signal: AbortSignal): Promise<{ title: string; content: string }>;
}
export class ChatError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) {
    super(code);
    this.name = "ChatError";
    this.code = code;
    this.retryable = retryable;
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function webUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ChatError("INVALID_URL"); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || value.length > 8192) {
    throw new ChatError("INVALID_URL");
  }
  url.hash = "";
  return url.href;
}
