/**
 * L3 — QR authentication and owner binding.
 * Input: project-local state, cancellation signal and optional verification input.
 * Output: credentials bound exclusively to the scanning user.
 * Pos: Weixin channel login; see ./L2.md.
 * Effects/Dependencies: Tencent login requests, local QR PNG and credential file.
 */
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import QRCode from "qrcode";
import { DEFAULT_API_URL, IlinkApi, IlinkError, validatedApiUrl } from "./api.ts";
import { ChannelState, parseCredentials } from "./state.ts";
import type { Credentials } from "./state.ts";

export interface LoginUi {
  log(message: string): void;
  verifyCode(): Promise<string>;
}

export async function login(state: ChannelState, signal: AbortSignal, ui: LoginUi): Promise<Credentials> {
  const initialApi = new IlinkApi();
  const existing = await state.credentials();
  const qr = await initialApi.request("/ilink/bot/get_bot_qrcode?bot_type=3", {
    signal, body: { local_token_list: existing ? [existing.token] : [] },
  });
  if (typeof qr.qrcode !== "string" || typeof qr.qrcode_img_content !== "string" || !qr.qrcode_img_content) {
    throw new IlinkError("INVALID_QR_RESPONSE");
  }
  await state.ensureDirectory();
  const imagePath = join(state.directory, "login-qr.png");
  await QRCode.toFile(imagePath, qr.qrcode_img_content, { width: 400, margin: 3, errorCorrectionLevel: "M" });
  ui.log(`请用你本人的手机微信扫码，并按手机提示确认。二维码：${imagePath}`);
  ui.log("扫码账号将成为唯一允许使用 Weave 的用户。");
  let api = initialApi;
  let code = "";
  let lastStatus = "";
  const deadline = Date.now() + 5 * 60_000;
  while (!signal.aborted && Date.now() < deadline) {
    let result;
    try {
      const query = new URLSearchParams({ qrcode: qr.qrcode });
      if (code) query.set("verify_code", code);
      result = await api.request(`/ilink/bot/get_qrcode_status?${query}`, { method: "GET", timeoutMs: 35_000, signal });
    } catch (error) {
      if (error instanceof IlinkError && ["TIMEOUT", "NETWORK", "HTTP_502", "HTTP_503", "HTTP_504"].includes(error.code)) {
        await delay(1500, undefined, { signal });
        continue;
      }
      throw error;
    }
    const status = result.status;
    if (status === "confirmed") {
      const credentials = parseCredentials({
        token: result.bot_token, botId: result.ilink_bot_id,
        ownerId: result.ilink_user_id, baseUrl: result.baseurl ?? api.baseUrl,
      });
      await state.saveCredentials(credentials);
      ui.log("登录成功，已绑定本人身份；登录凭据仅保存在本机 .weave 目录。");
      return credentials;
    }
    if (status === "expired") throw new Error("二维码已过期，请重新运行 npm run login。");
    if (status === "verify_code_blocked") throw new Error("手机验证次数已达上限，请重新登录。");
    if (status === "binded_redirect") {
      if (!existing) throw new Error("服务端提示已绑定，但本机没有凭据；请在微信管理界面检查绑定后重新登录。");
      ui.log("服务端提示已绑定，继续使用本机已有登录凭据。");
      return existing;
    }
    if (status === "scaned_but_redirect") {
      if (typeof result.redirect_host !== "string") throw new IlinkError("INVALID_REDIRECT");
      const host = result.redirect_host.includes("://") ? result.redirect_host : `https://${result.redirect_host}`;
      api = new IlinkApi(validatedApiUrl(host));
    } else if (status === "need_verifycode") {
      code = (await ui.verifyCode()).trim();
      if (!/^\d{4,12}$/.test(code)) throw new Error("请输入手机显示的数字验证码。");
    } else if (status !== "wait" && status !== "scaned") {
      throw new IlinkError("UNKNOWN_LOGIN_STATUS");
    }
    if (status === "scaned" && status !== lastStatus) ui.log("已扫码，请在手机微信中继续确认。");
    lastStatus = String(status);
    await delay(1000, undefined, { signal });
  }
  signal.throwIfAborted();
  throw new Error(`等待扫码超时，请重新运行 npm run login（${new URL(DEFAULT_API_URL).hostname}）。`);
}
