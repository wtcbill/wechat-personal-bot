/**
 * L3 — iLink HTTP transport.
 * Input: validated API host, endpoint, local credential and JSON payload.
 * Output: validated JSON records or errors containing only safe status codes.
 * Pos: Weixin channel transport; see ./L2.md.
 * Effects/Dependencies: HTTPS to Tencent; no request/response bodies are logged.
 */
import { randomBytes } from "node:crypto";

export const DEFAULT_API_URL = "https://ilinkai.weixin.qq.com";
// Wire compatibility reference: Tencent/openclaw-weixin 2.4.10.
const PROTOCOL_VERSION = "2.4.10";
export const BASE_INFO = { channel_version: PROTOCOL_VERSION, bot_agent: "Weave/0.1.0" };
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class IlinkError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`iLink 请求失败（${code}）`);
    this.name = "IlinkError";
    this.code = code;
  }
}

export function validatedApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new IlinkError("INVALID_API_HOST"); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com") ||
      url.username || url.password || url.port || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new IlinkError("INVALID_API_HOST");
  }
  return url.origin;
}

export class IlinkApi {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(baseUrl = DEFAULT_API_URL, fetcher: typeof fetch = fetch) {
    this.baseUrl = validatedApiUrl(baseUrl);
    this.fetcher = fetcher;
  }

  async request(endpoint: string, options: {
    method?: "GET" | "POST";
    body?: JsonRecord;
    token?: string;
    timeoutMs?: number;
    signal: AbortSignal;
  }): Promise<JsonRecord> {
    if (!endpoint.startsWith("/ilink/bot/")) throw new IlinkError("INVALID_ENDPOINT");
    const method = options.method ?? "POST";
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 10),
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64");
    }
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]);
    try {
      const response = await this.fetcher(new URL(endpoint, this.baseUrl), {
        method, headers, signal, redirect: "error",
        ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
      });
      if (!response.ok) throw new IlinkError(`HTTP_${response.status}`);
      const raw = await response.text();
      if (raw.length > 4_000_000) throw new IlinkError("RESPONSE_TOO_LARGE");
      let result: unknown;
      try {
        result = JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => {
          // Preserve numeric protocol IDs without losing int64 precision.
          return (key === "message_id" || key === "seq") && typeof value === "number"
            ? context?.source ?? String(value) : value;
        });
      } catch { throw new IlinkError("INVALID_JSON"); }
      if (!isRecord(result)) throw new IlinkError("INVALID_RESPONSE");
      for (const field of ["ret", "errcode"] as const) {
        const value = result[field];
        if (value !== undefined && value !== 0) {
          if (typeof value !== "number" || !Number.isInteger(value)) throw new IlinkError("INVALID_ERROR_CODE");
          throw new IlinkError(`API_${value}`);
        }
      }
      return result;
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      if (error instanceof IlinkError) throw error;
      if (signal.aborted) throw new IlinkError("TIMEOUT");
      throw new IlinkError("NETWORK");
    }
  }
}

export function safeError(error: unknown): string {
  return error instanceof IlinkError ? error.message : "操作未完成，请检查本机配置及网络。";
}
