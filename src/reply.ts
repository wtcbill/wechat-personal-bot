/**
 * L3 — Shared result-to-text presentation and Unicode-safe splitting.
 * Input: backend/router result and a per-message character budget.
 * Output: ordered answer/limitation parts; no automatic source list or badges.
 * Pos: application output boundary; see ./L2.md.
 * Effects/Dependencies: pure; no model calls, sending or delivery state.
 */
import type { ServiceResult } from "./services.ts";

export function formatReply(result: ServiceResult, maxChars = 1500): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 32 || maxChars > 4000) throw new Error("回复分段配置无效。");
  if (!["completed", "limited", "failed", "cancelled"].includes(result.status) || typeof result.answer !== "string" ||
      result.answer.length > 20_000 || !Array.isArray(result.sources) || !Array.isArray(result.limitations) ||
      result.sources.length > 30 || result.limitations.length > 30) throw new Error("后端结果格式无效。");
  const seen = new Set<string>();
  for (const source of result.sources) {
    if (typeof source.id !== "string" || typeof source.title !== "string" || typeof source.url !== "string") throw new Error("来源格式无效。");
    const url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("来源链接无效。");
    seen.add(source.id);
  }
  // Keep evidence in ServiceResult; the user-facing text omits internal markers.
  // Links explicitly included in the answer (for example when requested) remain.
  const answer = result.answer.replace(/\[S\d+\]/g, marker => seen.has(marker.slice(1, -1)) ? "" : marker).trim();
  const parts = [answer || "本次请求没有生成可发送的答案。"];
  const notes = [...new Set(result.limitations)];
  for (const note of notes) {
    if (typeof note !== "string" || note.length > 2000) throw new Error("结果限制说明无效。");
    if (note.trim()) parts.push(`限制：${note.trim()}`);
  }
  const text = parts.join("\n\n");
  if (text.length > 60_000) throw new Error("回复内容过长。");
  const chars = Array.from(text);
  const output: string[] = [];
  for (let offset = 0; offset < chars.length; offset += maxChars) output.push(chars.slice(offset, offset + maxChars).join(""));
  return output;
}
