/**
 * L3 — Local chat composition and interactive verification entry.
 * Input: check/ask, process-only DeepSeek key/model and terminal questions.
 * Output: offline configuration status or compact formatted answers/limitations.
 * Pos: standalone chat bootstrap; see ./L2.md.
 * Effects/Dependencies: check is offline and does not read credentials; ask calls
 * DeepSeek after explicit invocation. No file writes, iLink or service routing.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { DeepSeekClient } from "./deepseek.ts";
import { ChatService } from "./service.ts";
import { ChatError } from "./types.ts";
import { formatReply } from "../reply.ts";
import type { NetworkPolicy } from "../services.ts";

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new ChatError("NODE_24_REQUIRED");
  const command = args.shift() ?? "check";
  if (command === "check" && !args.length) {
    console.log("chat 离线检查通过：Node.js 24，内置 fetch，内存会话；未读取密钥、联网或写文件。");
    return;
  }
  if (command !== "ask") throw new ChatError("USAGE_CHECK_OR_ASK");
  const flags = args.filter(arg => arg.startsWith("--"));
  if (flags.length > 1 || flags.some(flag => !["--search", "--offline"].includes(flag))) throw new ChatError("INVALID_FLAGS");
  const network: NetworkPolicy = flags[0] === "--search" ? "required" : flags[0] === "--offline" ? "off" : "auto";
  const question = args.filter(arg => !arg.startsWith("--")).join(" ");
  const client = new DeepSeekClient({ apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash" });
  const service = new ChatService(client, client);
  const sessionId = randomUUID();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const ask = async (text: string): Promise<void> => {
    const result = await service.run({ sessionId, requestId: randomUUID(), text, network }, controller.signal);
    console.log(`\n${formatReply(result).join("\n")}`);
    console.log(`状态：${result.status}\n`);
  };
  try {
    if (question) { await ask(question); return; }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    console.log("本机 chat：/clear 清空对话，/exit 退出；Ctrl+C 取消并退出。历史只在内存。--offline 仅禁用搜索/抓取，Chat API 仍会联网。");
    try {
      while (!controller.signal.aborted) {
        let text: string;
        try { text = (await input.question("> ", { signal: controller.signal })).trim(); }
        catch { break; }
        if (text === "/exit") break;
        if (text === "/clear") { service.clearSession(sessionId); console.log("对话已清空。"); continue; }
        if (text) await ask(text);
      }
    } finally { input.close(); }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof ChatError ? `chat 无法启动（${error.code}）。请检查命令及本进程的 DEEPSEEK_API_KEY 配置。` : "chat 无法完成请求。");
    process.exitCode = 1;
  });
}
