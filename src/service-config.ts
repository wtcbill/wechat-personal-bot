/**
 * L3 — Independent router/chat API configuration schema and local loading.
 * Input: ignored services.config.local.json with optional shared/per-role key,
 * model settings and environment fallback names. Output: validated config.
 * Pos: service composition configuration; see ./L2.md.
 * Effects/Dependencies: may read local keys; never logs values or makes HTTP.
 */
import { readFile } from "node:fs/promises";

export interface ApiConfig { provider: "deepseek"; model: string; apiKeyEnv: string; apiKey?: string; requestTimeoutMs: number; thinkingTimeoutMs: number }
export interface ServiceConfig { apiKey: string; router: ApiConfig; chat: ApiConfig }
export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  apiKey: "",
  router: { provider: "deepseek", model: "deepseek-flash", apiKeyEnv: "WEAVE_ROUTER_API_KEY", requestTimeoutMs: 15_000, thinkingTimeoutMs: 60_000 },
  chat: { provider: "deepseek", model: "deepseek-flash", apiKeyEnv: "WEAVE_CHAT_API_KEY", requestTimeoutMs: 25_000, thinkingTimeoutMs: 60_000 },
};
export function parseServiceConfig(raw: unknown): ServiceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("服务 API 配置必须是对象。");
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some(key => !["apiKey", "router", "chat"].includes(key))) throw new Error("服务 API 配置含未知字段。");
  const config = structuredClone(DEFAULT_SERVICE_CONFIG);
  const validKey = (key: unknown): key is string => typeof key === "string" && key.length <= 4096 && !/[\r\n\0]/.test(key);
  if (obj.apiKey !== undefined) {
    if (!validKey(obj.apiKey)) throw new Error("共享 API Key 格式无效。");
    config.apiKey = obj.apiKey.trim();
  }
  for (const role of ["router", "chat"] as const) {
    const value = obj[role];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${role} API 配置无效。`);
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !["provider", "model", "apiKeyEnv", "apiKey", "requestTimeoutMs", "thinkingTimeoutMs"].includes(key))) {
      throw new Error(`${role} API 配置含未知字段。`);
    }
    const merged = { ...config[role], ...item };
    if (merged.provider !== "deepseek" || typeof merged.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(merged.model) ||
        typeof merged.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(merged.apiKeyEnv) ||
        (merged.apiKey !== undefined && !validKey(merged.apiKey)) ||
        !Number.isInteger(merged.requestTimeoutMs) || merged.requestTimeoutMs < 1 || merged.requestTimeoutMs > 120_000 ||
        !Number.isInteger(merged.thinkingTimeoutMs) || merged.thinkingTimeoutMs < 1 || merged.thinkingTimeoutMs > 120_000) {
      throw new Error(`${role} API 参数无效，请参考 services.config.example.json。`);
    }
    config[role] = merged as ApiConfig;
  }
  return config;
}
export async function loadServiceConfig(): Promise<ServiceConfig> {
  let text: string;
  try { text = await readFile(new URL("../services.config.local.json", import.meta.url), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SERVICE_CONFIG);
    throw new Error("服务 API 配置无法读取。");
  }
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown; } catch { throw new Error("服务 API 配置不是有效 JSON。"); }
  return parseServiceConfig(raw);
}
