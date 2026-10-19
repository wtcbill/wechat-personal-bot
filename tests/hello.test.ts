import { describe, expect, it, vi } from "vitest";
import { HelloApplication } from "../src/application.ts";
import type { InboundText, TextChannel } from "../src/contracts.ts";

const signal = new AbortController().signal;
const hello: InboundText = { id: "message:1", senderId: "owner", text: "你好", replyHandle: "handle" };
function fakeChannel() {
  return { receive: vi.fn<TextChannel["receive"]>(async () => []),
    sendReply: vi.fn<TextChannel["sendReply"]>(async () => ({ status: "accepted" })),
    release: vi.fn<TextChannel["release"]>(), checkpoint: vi.fn<TextChannel["checkpoint"]>(async () => {}) } satisfies TextChannel;
}

describe("owner-only acknowledgement", () => {
  it("responds once to a redelivered owner message and releases both handles", async () => {
    const channel = fakeChannel();
    const log = vi.fn();
    const app = new HelloApplication(channel, "owner", log);
    await app.handle(hello, signal);
    await app.handle({ ...hello, replyHandle: "redelivery" }, signal);
    expect(channel.sendReply).toHaveBeenCalledExactlyOnceWith("handle", "收到", signal);
    expect(channel.release).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat()).not.toContain("owner");
  });

  it.each([
    { ...hello, senderId: "stranger" },
    { ...hello, text: "帮助" },
    { ...hello, text: "你好，请问" },
  ])("ignores unauthorized users and non-trigger text: $senderId/$text", async message => {
    const channel = fakeChannel();
    await new HelloApplication(channel, "owner", vi.fn()).handle(message, signal);
    expect(channel.sendReply).not.toHaveBeenCalled();
    expect(channel.release).toHaveBeenCalledWith(message.replyHandle);
  });

  it("does not automatically resend an uncertain delivery, but accepts the next message", async () => {
    const channel = fakeChannel();
    channel.sendReply.mockRejectedValueOnce(new Error("timeout"));
    const log = vi.fn();
    const app = new HelloApplication(channel, "owner", log);
    await app.handle(hello, signal);
    await app.handle(hello, signal);
    await app.handle({ ...hello, id: "message:2" }, signal);
    expect(channel.sendReply).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("reply_failed_or_unknown");
    expect(log).toHaveBeenCalledWith("reply_accepted");
  });

  it("checkpoints only after a received batch is handled and stops on cancellation", async () => {
    const controller = new AbortController();
    const sequence: string[] = [];
    const channel: TextChannel = {
      receive: async () => [hello],
      sendReply: async () => { sequence.push("send"); return { status: "accepted" }; },
      release: () => { sequence.push("release"); },
      checkpoint: async () => { sequence.push("checkpoint"); controller.abort(); },
    };
    await new HelloApplication(channel, "owner", vi.fn()).run(controller.signal);
    expect(sequence).toEqual(["send", "release", "checkpoint"]);
  });

  it("records a submission without declaring delivery failure or resending", async () => {
    const channel = fakeChannel();
    channel.sendReply.mockResolvedValue({ status: "submitted" });
    const log = vi.fn();
    const app = new HelloApplication(channel, "owner", log);
    await app.handle(hello, signal);
    await app.handle(hello, signal);
    expect(channel.sendReply).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("reply_submitted");
    expect(log).not.toHaveBeenCalledWith("reply_failed_or_unknown");
    expect(log).not.toHaveBeenCalledWith("reply_accepted");
  });

  it("refuses to run without a known owner", () => {
    expect(() => new HelloApplication(fakeChannel(), "", vi.fn())).toThrow();
  });
});
