/**
 * L3 — Shared model messages, completion port and safe errors.
 * Input/Output: normalized completions; no routing or chat business state.
 * Pos: model provider contracts; see ./L2.md.
 * Effects/Dependencies: none.
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
export interface LanguageModel {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}

export class ModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) {
    super(code);
    this.name = "ModelError";
    this.code = code;
    this.retryable = retryable;
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
