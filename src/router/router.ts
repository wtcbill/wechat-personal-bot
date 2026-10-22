/**
 * L3 — Validated service dispatch, per-backend sessions and request reuse.
 * Input: application-scoped ServiceRequest and an injected intent model/registry.
 * Output: shared service results or readable routing/availability failures.
 * Pos: service routing coordinator; see ./L2.md.
 * Effects/Dependencies: bounded memory only; calls registered services once,
 * propagates cancellation, never sends replies or falls back to another service.
 */
import { randomUUID } from "node:crypto";
import type { Log } from "../contracts.ts";
import type { BackendService, NetworkPolicy, ServiceRequest, ServiceResult } from "../services.ts";
import { parseDecision } from "./types.ts";
import type { RegisteredService, RouteContext, RouteModel } from "./types.ts";

interface Session {
  bindings: Map<string, string>;
  active: string | null;
  recent: RouteContext["recent"];
  pending: { text: string; question: string; network: NetworkPolicy | undefined } | null;
  busy: boolean;
  at: number;
}
interface Cached { fingerprint: string; value: Promise<ServiceResult>; pending: boolean; at: number }
const result = (answer: string, status: ServiceResult["status"] = "completed"): ServiceResult => ({ status, answer, sources: [], limitations: [] });

function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("CANCELLED"));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

export class ServiceRouter implements BackendService {
  private readonly services = new Map<string, RegisteredService>();
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, Cached>();
  private readonly model: RouteModel;
  private readonly log: Log;
  private readonly timeoutMs: number;

  constructor(model: RouteModel, registry: RegisteredService[], log: Log = () => {}, timeoutMs = 15_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || registry.length > 10) throw new Error("路由配置无效。");
    for (const entry of registry) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(entry.id) || !entry.description.trim() || entry.description.length > 500 || this.services.has(entry.id)) {
        throw new Error("服务注册信息无效或重复。");
      }
      this.services.set(entry.id, { ...entry });
    }
    this.model = model; this.log = log; this.timeoutMs = timeoutMs;
  }

  async run(request: ServiceRequest, signal: AbortSignal): Promise<ServiceResult> {
    if (!request.sessionId.trim() || request.sessionId.length > 200 || !request.requestId.trim() || request.requestId.length > 200 ||
        !request.text.trim() || request.text.length > 12_000 || (request.network !== undefined && !["auto", "off", "required"].includes(request.network))) {
      return result("请求为空、过长或标识无效。", "failed");
    }
    const now = Date.now();
    for (const [key, cached] of this.requests) if (!cached.pending && now - cached.at > 30 * 60_000) this.requests.delete(key);
    for (const [key, session] of this.sessions) if (!session.busy && now - session.at > 30 * 60_000) this.sessions.delete(key);
    const key = JSON.stringify([request.sessionId, request.requestId]);
    const fingerprint = JSON.stringify([request.text, request.network ?? "auto"]);
    const cached = this.requests.get(key);
    if (cached) return cached.fingerprint === fingerprint ? structuredClone(await cached.value) : result("同一请求标识对应的内容已变化，请重新发送。", "failed");
    if (signal.aborted) return result("请求已取消。", "cancelled");
    let session = this.sessions.get(request.sessionId);
    if (session?.busy) return result("当前会话仍在处理中，请等待完成。", "limited");
    if (!session) {
      if (this.sessions.size >= 20) return result("会话数量已达到上限，请稍后重试。", "limited");
      session = { bindings: new Map(), active: null, recent: [], pending: null, busy: false, at: now };
      this.sessions.set(request.sessionId, session);
    }
    if (this.requests.size >= 100) {
      const disposable = [...this.requests].find(([, item]) => !item.pending);
      if (!disposable) return result("当前请求过多，请稍后重试。", "limited");
      this.requests.delete(disposable[0]);
    }
    session.busy = true;
    const owned = session;
    const record: Cached = { fingerprint, value: Promise.resolve(result("处理中")), pending: true, at: now };
    this.requests.set(key, record);
    record.value = this.execute(request, owned, signal).finally(() => {
      owned.busy = false; owned.at = Date.now(); record.pending = false; record.at = Date.now();
    });
    return structuredClone(await record.value);
  }

  private async execute(request: ServiceRequest, session: Session, signal: AbortSignal): Promise<ServiceResult> {
    const decisionSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const context: RouteContext = { text: request.text, services: [...this.services.values()].map(({ id, description }) => ({ id, description })),
      activeServiceId: session.active, recent: structuredClone(session.recent),
      pending: session.pending ? { text: session.pending.text, question: session.pending.question } : null, correction: null };
    try {
      let decision = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await bounded(() => this.model.decide(structuredClone(context), decisionSignal), decisionSignal);
        decision = parseDecision(raw);
        if (decision && (decision.action !== "dispatch" || this.services.has(decision.serviceId))) break;
        decision = null;
        context.correction = "上次返回格式无效或服务未注册；请严格使用三种决定之一，dispatch只能选择本次services中的标识。";
      }
      if (!decision) return result("服务路由未能给出有效选择，请换一种说法重试。", "failed");
      signal.throwIfAborted();
      session.recent.push({ text: request.text.slice(0, 500), action: decision.action,
        serviceId: decision.action === "dispatch" ? decision.serviceId : null });
      session.recent = session.recent.slice(-8);
      if (decision.action === "unsupported") {
        session.pending = null;
        this.log("route_unsupported");
        return result(decision.reason, "limited");
      }
      const pending = decision.action === "dispatch" && decision.session === "new" ? null : session.pending;
      const text = pending ? `原请求：\n${pending.text}\n待澄清问题：\n${pending.question}\n用户补充：\n${request.text}` : request.text;
      if (text.length > 12_000) return result("澄清上下文过长，请重新完整描述任务。", "limited");
      const network = pending?.network === "off" || request.network === "off" ? "off" :
        pending?.network === "required" || request.network === "required" ? "required" : request.network ?? pending?.network;
      if (decision.action === "clarify") {
        session.pending = { text, question: decision.question, network };
        this.log("route_clarify");
        return result(decision.question);
      }
      const selected = this.services.get(decision.serviceId)!;
      let backendSession = session.bindings.get(selected.id);
      if (!backendSession || decision.session === "new") {
        backendSession = randomUUID(); session.bindings.set(selected.id, backendSession);
      }
      session.active = selected.id; session.pending = null;
      this.log(`route_selected:${selected.id}`);
      const serviceRequest: ServiceRequest = { sessionId: backendSession, requestId: request.requestId, text,
        ...(network === undefined ? {} : { network }) };
      try { return await bounded(() => selected.service.run(serviceRequest, signal), signal); }
      catch { return signal.aborted ? result("请求已取消。", "cancelled") : result("后端服务处理失败，请稍后重新发送；本次未自动重试或切换服务。", "failed"); }
    } catch {
      if (signal.aborted) return result("请求已取消。", "cancelled");
      return result(decisionSignal.aborted ? "服务路由超时，请稍后重试。" : "服务路由暂时不可用，请稍后重试。", "failed");
    }
  }
}
