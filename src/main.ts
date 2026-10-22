/**
 * L3 — Command-line assembly for real terminal/iLink dialogue.
 * Input: check/login/start/api-check, --debug and legacy routed/api flags.
 * Output: configuration report or replies via the selected text channel.
 * Pos: composition root; see ./L2.md.
 * Effects/Dependencies: all start commands use configured real APIs; --debug
 * selects the terminal, otherwise iLink. API config precedes login.
 */
import { createInterface } from "node:readline/promises";
import { Application } from "./application.ts";
import { ConsoleChannel } from "./console-channel.ts";
import { IlinkError, safeError } from "./weixin_ilink/api.ts";

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => controller.abort());
const log = (message: string): void => { console.log(`${new Date().toISOString()} ${message}`); };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.startsWith("--") ? "start" : args.shift() ?? "start";
  let debug = false;
  let mode = "routed";
  let backend = "api";
  const seen = new Set<string>();
  const usage = () => new Error("用法：npm start 启用真实微信问答；npm start -- --debug 启用真实终端对话。或 npm run config:check、npm run login、npm run api:check。--mode routed、--backend api 仅用于兼容旧命令。");
  while (args.length) {
    const flag = args.shift()!;
    if (seen.has(flag)) throw usage();
    seen.add(flag);
    if (flag === "--debug") debug = true;
    else if (flag === "--mode") mode = args.shift() ?? "";
    else if (flag === "--backend") backend = args.shift() ?? "";
    else throw usage();
  }
  if (!["check", "login", "start", "api-check"].includes(command) ||
      (command !== "start" && seen.size > 0) || mode !== "routed" || backend !== "api") throw usage();
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("请使用 Node.js 24 LTS 运行 Weave。");
  if (command === "api-check") {
    const { loadServiceConfig } = await import("./service-config.ts");
    const config = await loadServiceConfig();
    console.log(`API 配置结构检查通过：router=${config.router.model}，chat=${config.chat.model}。未联网、输出密钥或写文件。`);
    return;
  }
  const processor = command === "start"
    ? await (await import("./service-bootstrap.ts")).buildServices(log) : undefined;
  if (debug && processor) {
    console.log("路由调试模式【真实 API】：输入将调用配置的路由和 chat 模型；不连接微信。/exit 或 Ctrl+C 退出。");
    const channel = new ConsoleChannel(process.stdin, process.stdout, () => controller.abort());
    const application = new Application(channel, channel.ownerId, processor, log);
    try { await application.run(controller.signal); }
    finally { channel.close(); }
    return;
  }
  const { DATA_DIRECTORY, loadConfig } = await import("./config.ts");
  const { WeixinChannel } = await import("./weixin_ilink/channel.ts");
  const { login } = await import("./weixin_ilink/login.ts");
  const { ChannelState } = await import("./weixin_ilink/state.ts");
  const config = await loadConfig();
  const state = new ChannelState(DATA_DIRECTORY);
  if (command === "check") {
    const credentials = await state.credentials();
    log(`配置检查通过；Node.js ${process.versions.node}；模式：本人专用微信问答。`);
    log(credentials ? "本机登录状态完整，已绑定本人；本检查未联网。" : "尚未登录；运行 npm run login 或 npm start 获取二维码。检查未联网。");
    return;
  }
  const unlock = await state.lock();
  try {
    let credentials = await state.credentials();
    if (command === "login" || !credentials) {
      credentials = await login(state, controller.signal, {
        log,
        async verifyCode() {
          const input = createInterface({ input: process.stdin, output: process.stdout });
          try { return await input.question("请在此终端输入手机显示的验证码：", { signal: controller.signal }); }
          finally { input.close(); }
        },
      });
    }
    if (command === "login") return;
    if (!processor) throw usage();
    const channel = new WeixinChannel(credentials, state, config);
    await channel.initialize();
    await channel.lifecycle("start", controller.signal).catch(() => log("启动通知未确认，继续检查消息接收。"));
    log("微信问答已启动。本人发送文本后将经真实路由与 chat 处理并回复。按 Ctrl+C 停止。");
    const application = new Application(channel, credentials.ownerId, processor, log);
    try { await application.run(controller.signal); }
    finally {
      await channel.lifecycle("stop", AbortSignal.timeout(3000)).catch(() => {});
    }
  } finally { await unlock(); }
}

await main().catch((error: unknown) => {
  if (controller.signal.aborted) { log("Weave 已停止。"); return; }
  // Our own validation errors contain actionable fixed messages; never print a stack/body.
  const message = error instanceof IlinkError ? safeError(error) :
    error instanceof Error && !((error as NodeJS.ErrnoException).code) ? error.message : safeError(error);
  console.error(message);
  process.exitCode = 1;
});
