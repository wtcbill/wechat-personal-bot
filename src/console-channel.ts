/**
 * L3 — Terminal text channel for local application debugging.
 * Input: stdin lines as a local debug identity, cancellation and reply handles.
 * Output: channel-neutral messages and bot replies on stdout; null at input end.
 * Pos: alternate TextChannel adapter; see ./L2.md.
 * Effects/Dependencies: readline and injected streams only; no credentials,
 * network, files, iLink state or backend selection. Application owns responses.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { InboundText, SendReceipt, TextChannel } from "./contracts.ts";

export class ConsoleChannel implements TextChannel {
  readonly ownerId = "console:owner";
  private readonly reader: Interface;
  private readonly lines: AsyncIterableIterator<string>;
  private readonly output: Writable;
  private readonly terminal: boolean;
  private readonly handles = new Set<string>();
  private stopped = false;

  constructor(input: Readable, output: Writable, onInterrupt: () => void) {
    this.output = output;
    this.terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
    this.reader = createInterface({ input, output, terminal: this.terminal, crlfDelay: Infinity, historySize: 0 });
    // Attach the iterator immediately so piped/pasted lines are retained while
    // the application is processing the previous message.
    this.lines = this.reader[Symbol.asyncIterator]();
    this.reader.on("SIGINT", onInterrupt);
  }

  async receive(signal: AbortSignal): Promise<InboundText[] | null> {
    signal.throwIfAborted();
    const stop = () => this.close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      while (!this.stopped) {
        if (this.terminal) this.reader.prompt();
        const next = await this.lines.next();
        signal.throwIfAborted();
        if (next.done || next.value.trim() === "/exit") {
          this.close();
          return null;
        }
        if (!next.value.trim()) continue;
        const id = randomUUID();
        this.handles.add(id);
        return [{ id, senderId: this.ownerId, text: next.value, replyHandle: id }];
      }
      return null;
    } finally { signal.removeEventListener("abort", stop); }
  }

  async sendReply(replyHandle: string, text: string, signal: AbortSignal): Promise<SendReceipt> {
    signal.throwIfAborted();
    if (!this.handles.has(replyHandle)) throw new Error("终端回复句柄已失效。");
    await new Promise<void>((resolve, reject) => {
      this.output.write(`bot> ${text}\n`, error => error ? reject(error) : resolve());
    });
    return { status: "accepted" };
  }

  release(replyHandle: string): void { this.handles.delete(replyHandle); }
  async checkpoint(): Promise<void> { /* Terminal input has no persistent cursor. */ }

  close(): void {
    this.stopped = true;
    this.reader.close();
    this.handles.clear();
  }
}
