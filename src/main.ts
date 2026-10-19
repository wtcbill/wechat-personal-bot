/**
 * L3 — Command-line assembly for the owner-only hello probe.
 * Input: check/login/start command, local configuration and QR confirmation.
 * Output: offline configuration report or a running Weixin text acknowledgement.
 * Pos: composition root; see ./L2.md.
 * Effects/Dependencies: assembles channel, login, process lock and shutdown handling.
 */
import { createInterface } from "node:readline/promises";
import { HelloApplication } from "./application.ts";
import { DATA_DIRECTORY, loadConfig } from "./config.ts";
import { IlinkError, safeError } from "./weixin/api.ts";
import { WeixinChannel } from "./weixin/channel.ts";
import { login } from "./weixin/login.ts";
import { ChannelState } from "./weixin/state.ts";

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => controller.abort());
const log = (message: string): void => { console.log(`${new Date().toISOString()} ${message}`); };

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  if (!["check", "login", "start"].includes(command) || process.argv.length > 3) {
    throw new Error("用法：npm run config:check、npm run login 或 npm start。");
  }
  const config = await loadConfig();
  const state = new ChannelState(DATA_DIRECTORY);
  if (command === "check") {
    const credentials = await state.credentials();
    log(`配置检查通过；Node.js ${process.versions.node}；模式：本人私聊收发验证。`);
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
    const channel = new WeixinChannel(credentials, state, config);
    await channel.initialize();
    await channel.lifecycle("start", controller.signal).catch(() => log("启动通知未确认，继续检查消息接收。"));
    log("收发验证已启动。请在手机微信的对应会话发送“你好”，程序将回复“收到”。按 Ctrl+C 停止。");
    try { await new HelloApplication(channel, credentials.ownerId, log).run(controller.signal); }
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
