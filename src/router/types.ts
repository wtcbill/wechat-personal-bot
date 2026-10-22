/**
 * L3 — Router-owned intent decisions and limited conversation context.
 * Input/Output: service descriptions and validated dispatch/clarify/unsupported.
 * Pos: routing contracts; see ./L2.md.
 * Effects/Dependencies: no provider, channel or chat business dependencies.
 */
import type { BackendService } from "../services.ts";

export interface RegisteredService { id: string; description: string; service: BackendService }
export type RouteDecision =
  | { action: "dispatch"; serviceId: string; session: "continue" | "new" }
  | { action: "clarify"; question: string }
  | { action: "unsupported"; reason: string };
export interface RouteContext {
  text: string;
  services: { id: string; description: string }[];
  activeServiceId: string | null;
  recent: { text: string; action: string; serviceId: string | null }[];
  pending: { text: string; question: string } | null;
  correction: string | null;
}
export interface RouteModel { decide(context: RouteContext, signal: AbortSignal): Promise<unknown> }

export function parseDecision(raw: unknown): RouteDecision | null {
  if (typeof raw === "string") {
    if (raw.length > 4000) return null;
    try { raw = JSON.parse(raw) as unknown; } catch { return null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const keys = Object.keys(item);
  if (item.action === "dispatch" && keys.length === 3 && typeof item.serviceId === "string" &&
      /^[a-z][a-z0-9_-]{0,39}$/.test(item.serviceId) && (item.session === "continue" || item.session === "new")) {
    return { action: "dispatch", serviceId: item.serviceId, session: item.session };
  }
  if (item.action === "clarify" && keys.length === 2 && typeof item.question === "string" && item.question.trim() && item.question.length <= 500) {
    return { action: "clarify", question: item.question.trim() };
  }
  if (item.action === "unsupported" && keys.length === 2 && typeof item.reason === "string" && item.reason.trim() && item.reason.length <= 500) {
    return { action: "unsupported", reason: item.reason.trim() };
  }
  return null;
}
