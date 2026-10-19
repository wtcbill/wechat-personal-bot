/**
 * L3 — iLink text conversion, polling and replies.
 * Input: channel credential, incoming protocol messages and opaque reply handles.
 * Output: channel-neutral text; submitted/acknowledged receipt or safe failure.
 * Pos: Weixin channel adapter; see ./L2.md.
 * Effects/Dependencies: Tencent requests, durable cursor; reply tokens live in memory.
 */
import { randomUUID } from "node:crypto";
import type { InboundText, SendReceipt, TextChannel } from "../contracts.ts";
import { BASE_INFO, IlinkApi, IlinkError, isRecord } from "./api.ts";
import type { JsonRecord } from "./api.ts";
import { ChannelState } from "./state.ts";
import type { Credentials } from "./state.ts";

export interface PollConfig { pollTimeoutMs: number; requestTimeoutMs: number }
interface ReplyTarget { userId: string; contextToken: string }

export function inboundText(raw: unknown, botId: string): { message: Omit<InboundText, "replyHandle">; target: ReplyTarget } | undefined {
  if (!isRecord(raw) || raw.message_type !== 1 || raw.group_id ||
      typeof raw.from_user_id !== "string" || !raw.from_user_id ||
      (typeof raw.to_user_id === "string" && raw.to_user_id !== botId) ||
      typeof raw.context_token !== "string" || !raw.context_token || !Array.isArray(raw.item_list)) return;
  const identity = raw.message_id ?? raw.client_id ?? raw.seq;
  if ((typeof identity !== "string" && typeof identity !== "number") || String(identity).length === 0) return;
  // Text-only probe: skip attachments and unsupported mixed messages.
  if (raw.item_list.length === 0 || raw.item_list.some(item => !isRecord(item) || item.type !== 1)) return;
  const pieces: string[] = [];
  for (const item of raw.item_list) {
    if (!isRecord(item) || !isRecord(item.text_item) || typeof item.text_item.text !== "string") return;
    pieces.push(item.text_item.text);
  }
  return {
    message: { id: `${raw.message_id !== undefined ? "message" : raw.client_id !== undefined ? "client" : "seq"}:${identity}`, senderId: raw.from_user_id, text: pieces.join("\n") },
    target: { userId: raw.from_user_id, contextToken: raw.context_token },
  };
}

export class WeixinChannel implements TextChannel {
  private cursor = "";
  private pendingCursor = "";
  private pollTimeoutMs: number;
  private readonly targets = new Map<string, ReplyTarget>();
  readonly api: IlinkApi;
  private readonly credentials: Credentials;
  private readonly state: ChannelState;
  private readonly config: PollConfig;
  constructor(credentials: Credentials, state: ChannelState, config: PollConfig, api?: IlinkApi) {
    this.credentials = credentials;
    this.state = state;
    this.config = config;
    this.api = api ?? new IlinkApi(credentials.baseUrl);
    this.pollTimeoutMs = config.pollTimeoutMs;
  }

  async initialize(): Promise<void> { this.cursor = await this.state.cursor(this.credentials.botId); }

  async lifecycle(event: "start" | "stop", signal: AbortSignal): Promise<void> {
    await this.api.request(`/ilink/bot/msg/notify${event}`, {
      body: { base_info: BASE_INFO }, token: this.credentials.token,
      timeoutMs: this.config.requestTimeoutMs, signal,
    });
  }

  async receive(signal: AbortSignal): Promise<InboundText[]> {
    let response: JsonRecord;
    try {
      response = await this.api.request("/ilink/bot/getupdates", {
        token: this.credentials.token,
        body: { get_updates_buf: this.cursor, base_info: BASE_INFO },
        timeoutMs: this.pollTimeoutMs + 5000, signal,
      });
    } catch (error) {
      if (error instanceof IlinkError && error.code === "TIMEOUT" && !signal.aborted) return [];
      if (error instanceof IlinkError && ["API_-14", "HTTP_401", "HTTP_403"].includes(error.code)) {
        const authError = new Error("微信会话失效，请重新运行 npm run login。");
        authError.name = "ChannelAuthenticationError";
        throw authError;
      }
      throw error;
    }
    if (response.msgs !== undefined && !Array.isArray(response.msgs)) throw new IlinkError("INVALID_MESSAGES");
    if (typeof response.longpolling_timeout_ms === "number" && Number.isFinite(response.longpolling_timeout_ms)) {
      this.pollTimeoutMs = Math.max(1000, Math.min(response.longpolling_timeout_ms, 120_000));
    }
    this.pendingCursor = typeof response.get_updates_buf === "string" && response.get_updates_buf
      ? response.get_updates_buf : this.cursor;
    const messages: InboundText[] = [];
    for (const raw of (response.msgs ?? []) as unknown[]) {
      const converted = inboundText(raw, this.credentials.botId);
      if (!converted || converted.message.senderId !== this.credentials.ownerId) continue;
      const replyHandle = randomUUID();
      this.targets.set(replyHandle, converted.target);
      messages.push({ ...converted.message, replyHandle });
    }
    return messages;
  }

  async sendReply(replyHandle: string, text: string, signal: AbortSignal): Promise<SendReceipt> {
    const target = this.targets.get(replyHandle);
    if (!target || target.userId !== this.credentials.ownerId) throw new IlinkError("INVALID_REPLY_TARGET");
    const response = await this.api.request("/ilink/bot/sendmessage", {
      token: this.credentials.token, timeoutMs: this.config.requestTimeoutMs, signal,
      body: {
        msg: { from_user_id: "", to_user_id: target.userId, client_id: `weave-${randomUUID()}`,
          message_type: 2, message_state: 2, context_token: target.contextToken,
          item_list: [{ type: 1, text_item: { text } }] },
        base_info: BASE_INFO,
      },
    });
    // Upstream allows send responses without ret. Transport already rejects HTTP
    // and explicit business errors; absence of an acknowledgement is not failure.
    return { status: response.ret === 0 || response.errcode === 0 ? "accepted" : "submitted" };
  }

  release(replyHandle: string): void { this.targets.delete(replyHandle); }

  async checkpoint(): Promise<void> {
    if (this.pendingCursor && this.pendingCursor !== this.cursor) {
      await this.state.saveCursor(this.credentials.botId, this.pendingCursor);
      this.cursor = this.pendingCursor;
    }
  }
}
