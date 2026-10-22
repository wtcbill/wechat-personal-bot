import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ConsoleChannel } from "../src/console-channel.ts";

function consoleChannel() {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  let text = "";
  output.setEncoding("utf8").on("data", chunk => { text += chunk; });
  const channel = new ConsoleChannel(input, output, () => controller.abort());
  return { input, controller, channel, text: () => text };
}

describe("console channel with real streams", () => {
  it("drains buffered lines and sends replies, preserving text and distinct message IDs", async () => {
    const env = consoleChannel();
    env.input.end("第一条\n  第二条  \n\n第一条");
    try {
      const messages = [];
      for (;;) {
        const batch = await env.channel.receive(env.controller.signal);
        if (batch === null) break;
        for (const message of batch) {
          messages.push(message);
          expect(await env.channel.sendReply(message.replyHandle, "实际终端输出", env.controller.signal)).toEqual({ status: "accepted" });
          env.channel.release(message.replyHandle);
        }
      }
      expect(messages.map(message => message.text)).toEqual(["第一条", "  第二条  ", "第一条"]);
      expect(new Set(messages.map(message => message.id)).size).toBe(3);
      expect(messages.every(message => message.senderId === env.channel.ownerId)).toBe(true);
      expect(env.text()).toBe("bot> 实际终端输出\nbot> 实际终端输出\nbot> 实际终端输出\n");
      expect(env.controller.signal.aborted).toBe(false);
    } finally { env.channel.close(); }
  });

  it("processes earlier messages then stops at /exit without processing later lines", async () => {
    const env = consoleChannel();
    env.input.end("先处理\n/exit\n不处理\n");
    try {
      const first = await env.channel.receive(env.controller.signal);
      expect(first?.map(message => message.text)).toEqual(["先处理"]);
      expect(await env.channel.receive(env.controller.signal)).toBeNull();
      expect(await env.channel.receive(env.controller.signal)).toBeNull();
    } finally { env.channel.close(); }
  });

  it("cancels a pending terminal read", async () => {
    const env = consoleChannel();
    try {
      const running = env.channel.receive(env.controller.signal);
      const cancelled = expect(running).rejects.toMatchObject({ name: "AbortError" });
      env.controller.abort();
      await cancelled;
      expect(env.text()).toBe("");
    } finally { env.channel.close(); }
  });

  it("does not accept released or unknown reply handles", async () => {
    const env = consoleChannel();
    try {
      env.input.end("消息\n");
      const messages = await env.channel.receive(env.controller.signal);
      const message = messages?.[0];
      expect(message).toBeDefined();
      env.channel.release(message!.replyHandle);
      await expect(env.channel.sendReply(message!.replyHandle, "回复", env.controller.signal)).rejects.toThrow("句柄已失效");
      await expect(env.channel.sendReply("unknown", "回复", env.controller.signal)).rejects.toThrow("句柄已失效");
      expect(env.text()).toBe("");
    } finally { env.channel.close(); }
  });
});

const root = fileURLToPath(new URL("../", import.meta.url));
function runDebug(args: string[], input: string): Promise<{ code: string | number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Permit source reads only. Actual startup must validate API config before
    // reading Weixin credentials or creating locks; no model/HTTP substitutes.
    const child = execFile(process.execPath, ["--permission", `--allow-fs-read=${join(root, "src")}`,
      `--allow-fs-read=${join(root, "package.json")}`,
      join(root, "src/main.ts"), ...args], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true },
    (error, stdout, stderr) => {
      if (error?.killed) { reject(error); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

describe("debug startup", () => {
  it.each([["start"], ["start", "--debug"], ["start", "--mode", "routed"], ["--debug"]])("requires real API config before opening channel: %j", async (...args) => {
    const result = await runDebug(args, "");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("服务 API 配置无法读取");
    expect(result.stderr).not.toContain("用法：");
    expect(result.stdout).toBe("");
  });

  it.each([["login", "--debug"], ["check", "--debug"], ["start", "--debug", "--debug"], ["start", "--typo"]])(
    "rejects invalid arguments %j before opening the real channel", async (...args) => {
      const result = await runDebug(args, "");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("用法：");
      expect(result.stdout).toBe("");
    });

  it.each([["start", "--mode", "routed", "--backend"], ["start", "--mode", "hello"], ["start", "--debug", "--mode", "hello"],
    ["start", "--debug", "--mode", "wrong"], ["start", "--debug", "--mode", "routed", "--backend", "mock"]])(
    "rejects unsafe/incomplete mode combinations %#", async (...args) => {
      const result = await runDebug(args, "");
      expect(result.code).toBe(1); expect(result.stderr).toContain("用法：");
    });
});
