/**
 * L3 — Backend service boundary.
 * Input: caller-owned session/request IDs, text and optional network policy.
 * Output: a reusable result, independent of delivery and provider protocols.
 * Pos: shared service contracts; see ./L2.md.
 * Effects/Dependencies: none. Session ownership/selection stays with the caller.
 */
export type NetworkPolicy = "auto" | "required" | "off";
export interface ServiceRequest {
  sessionId: string;
  requestId: string;
  text: string;
  network?: NetworkPolicy;
}
export interface AnswerSource {
  id: string;
  url: string;
  title: string;
  publishedAt: string | null;
  retrievedAt: string | null;
  excerpt: string;
  status: "unread" | "summary" | "read" | "failed";
  truncated: boolean;
}
export interface ServiceResult {
  status: "completed" | "limited" | "failed" | "cancelled";
  answer: string;
  sources: AnswerSource[];
  limitations: string[];
}
export interface BackendService {
  run(request: ServiceRequest, signal: AbortSignal): Promise<ServiceResult>;
}
