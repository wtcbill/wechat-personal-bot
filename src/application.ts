/**
 * L3 — Owner-only application execution and reply coordination.
 * Input: channel-neutral text, owner and an injected request processor.
 * Output: formatted service replies and in-memory delivery status.
 * Pos: application policy; see ./L2.md.
 * Effects/Dependencies: injected processor/channel calls and bounded in-memory
 * request/result/delivery records. Uncertain sends never rerun the processor.
 */
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { InboundText, Log, TextChannel } from "./contracts.ts";
import type { BackendService, ServiceResult } from "./services.ts";
import { formatReply } from "./reply.ts";

export interface DeliveryRecord {
  state: "processing" | "ready" | "accepted" | "submitted" | "failed_or_unknown" | "cancelled";
  result: ServiceResult | null;
  parts: string[];
  sentParts: number;
  fingerprint: string;
  at: number;
}

export class Application {
  private readonly handled = new Map<string, DeliveryRecord>();
  private readonly channel: TextChannel;
  private readonly ownerId: string;
  private readonly log: Log;
  private readonly processor: BackendService;
  private readonly sessionId = randomUUID();
  constructor(channel: TextChannel, ownerId: string, processor: BackendService, log: Log) {
    if (!ownerId.trim()) throw new Error("缺少本人身份，请先登录。");
    this.channel = channel;
    this.ownerId = ownerId;
    this.log = log;
    this.processor = processor;
  }

  delivery(messageId: string): DeliveryRecord | undefined {
    const item = this.handled.get(`${this.ownerId}\u0000${messageId}`);
    return item ? structuredClone(item) : undefined;
  }

  async handle(message: InboundText, signal: AbortSignal): Promise<void> {
    try {
      if (message.senderId !== this.ownerId || !message.text.trim()) return;
      signal.throwIfAborted();
      const key = `${message.senderId}\u0000${message.id}`;
      const now = Date.now();
      for (const [id, item] of this.handled) {
        if (item.state !== "processing" && now - item.at > 30 * 60_000) this.handled.delete(id);
      }
      const previous = this.handled.get(key);
      if (previous) {
        if (previous.fingerprint !== message.text) this.log("request_id_conflict");
        return;
      }
      if (this.handled.size >= 100) {
        const disposable = [...this.handled].find(([, item]) => item.state !== "processing");
        if (!disposable) { this.log("application_busy"); return; }
        this.handled.delete(disposable[0]);
      }
      // An uncertain send must not be automatically repeated on redelivery.
      const record: DeliveryRecord = { state: "processing", result: null, parts: [], sentParts: 0, fingerprint: message.text, at: now };
      this.handled.set(key, record);
      this.log("request_received");
      try {
        let result: ServiceResult;
        try {
          result = await this.processor.run({ sessionId: this.sessionId, requestId: message.id, text: message.text }, signal);
          signal.throwIfAborted();
          record.parts = formatReply(result);
        } catch {
          if (signal.aborted) throw signal.reason;
          result = { status: "failed", answer: "服务处理失败或返回格式无效，请稍后重新发送。", sources: [], limitations: [] };
          record.parts = formatReply(result);
        }
        record.result = structuredClone(result);
        record.state = "ready";
        this.log(`backend_${result.status}`);
        let submitted = false;
        for (const part of record.parts) {
          signal.throwIfAborted();
          const receipt = await this.channel.sendReply(message.replyHandle, part, signal);
          record.sentParts++;
          if (receipt.status === "submitted") submitted = true;
          this.log(receipt.status === "accepted" ? "reply_accepted" : "reply_submitted");
        }
        record.state = submitted ? "submitted" : "accepted";
      } catch (error) {
        if (signal.aborted) { record.state = "cancelled"; throw error; }
        record.state = "failed_or_unknown";
        this.log("reply_failed_or_unknown");
      } finally { record.at = Date.now(); }
    } finally { this.channel.release(message.replyHandle); }
  }

  async run(signal: AbortSignal): Promise<void> {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        const messages = await this.channel.receive(signal);
        if (messages === null) break;
        for (const message of messages) {
          signal.throwIfAborted();
          await this.handle(message, signal);
        }
        await this.channel.checkpoint();
        retryMs = 1000;
      } catch (error) {
        if (signal.aborted) break;
        // Channel classifies authentication failures as fatal; do not hammer login.
        if (error instanceof Error && error.name === "ChannelAuthenticationError") throw error;
        this.log("receive_retry");
        await delay(retryMs, undefined, { signal }).catch(() => {});
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  }
}
