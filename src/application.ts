/**
 * L3 — Owner-only hello acknowledgement.
 * Input: channel-neutral text and the owner from authenticated login.
 * Output: only the owner's exact trimmed "你好" receives "收到".
 * Pos: application policy; see ./L2.md.
 * Effects/Dependencies: channel sends via injected interface, bounded memory dedup.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { InboundText, Log, TextChannel } from "./contracts.ts";

export class HelloApplication {
  private readonly handled = new Map<string, number>();
  private readonly channel: TextChannel;
  private readonly ownerId: string;
  private readonly log: Log;
  constructor(channel: TextChannel, ownerId: string, log: Log) {
    if (!ownerId.trim()) throw new Error("缺少本人身份，请先登录。");
    this.channel = channel;
    this.ownerId = ownerId;
    this.log = log;
  }

  async handle(message: InboundText, signal: AbortSignal): Promise<void> {
    try {
      if (message.senderId !== this.ownerId || message.text.trim() !== "你好") return;
      const key = `${message.senderId}\u0000${message.id}`;
      const now = Date.now();
      for (const [id, at] of this.handled) {
        if (now - at > 24 * 60 * 60_000 || this.handled.size >= 10_000) this.handled.delete(id);
        else break;
      }
      if (this.handled.has(key)) return;
      // An uncertain send must not be automatically repeated on redelivery.
      this.handled.set(key, now);
      this.log("owner_hello_received");
      try {
        const receipt = await this.channel.sendReply(message.replyHandle, "收到", signal);
        this.log(receipt.status === "accepted" ? "reply_accepted" : "reply_submitted");
      } catch (error) {
        if (signal.aborted) throw error;
        this.log("reply_failed_or_unknown");
      }
    } finally { this.channel.release(message.replyHandle); }
  }

  async run(signal: AbortSignal): Promise<void> {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        const messages = await this.channel.receive(signal);
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
