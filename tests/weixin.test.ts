import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { HelloApplication } from "../src/application.ts";
import { PROJECT_ROOT } from "../src/config.ts";
import { IlinkApi, IlinkError, safeError, validatedApiUrl } from "../src/weixin/api.ts";
import { inboundText, WeixinChannel } from "../src/weixin/channel.ts";
import { ChannelState, parseCredentials } from "../src/weixin/state.ts";
import { login } from "../src/weixin/login.ts";

const signal = new AbortController().signal;
const credentials = { token: "fake-local-token", botId: "bot", ownerId: "owner", baseUrl: "https://ilinkai.weixin.qq.com" };
const rawMessage = { message_id: "1", from_user_id: "owner", to_user_id: "bot", message_type: 1,
  context_token: "fake-reply-token", item_list: [{ type: 1, text_item: { text: "你好" } }] };
const temporaryDirectories: string[] = [];
async function state(): Promise<ChannelState> {
  await mkdir(join(PROJECT_ROOT, ".cache"), { recursive: true });
  const directory = await mkdtemp(join(PROJECT_ROOT, ".cache", "test-"));
  temporaryDirectories.push(directory);
  return new ChannelState(directory);
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(PROJECT_ROOT, ".cache") + sep)) throw new Error("Invalid test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

describe("protocol boundary", () => {
  it.each([
    "http://ilinkai.weixin.qq.com", "https://attacker.test", "https://weixin.qq.com.attacker.test",
    "https://user:password@ilinkai.weixin.qq.com", "https://ilinkai.weixin.qq.com:8443",
  ])("rejects unsafe API/redirect hosts: %s", value => {
    expect(() => validatedApiUrl(value)).toThrow(IlinkError);
  });

  it("sets POST authentication headers and preserves int64 message IDs", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"ret":0,"msgs":[{"message_id":9223372036854775807}]}'));
    const api = new IlinkApi(credentials.baseUrl, fetcher);
    const response = await api.request("/ilink/bot/getupdates", { token: credentials.token, body: {}, signal });
    expect((response.msgs as { message_id: string }[])[0]?.message_id).toBe("9223372036854775807");
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fake-local-token", AuthorizationType: "ilink_bot_token", "iLink-App-Id": "bot" });
    expect(init?.redirect).toBe("error");
  });

  it("keeps credentials off QR-status GET requests", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: "wait" }));
    await new IlinkApi(credentials.baseUrl, fetcher).request("/ilink/bot/get_qrcode_status?qrcode=test", { method: "GET", signal });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("AuthorizationType");
  });

  it("does not expose response secrets through business or HTTP errors", async () => {
    for (const response of [Response.json({ ret: -14, errmsg: "private-token-secret" }), new Response("private-token-secret", { status: 500 })]) {
      const api = new IlinkApi(credentials.baseUrl, async () => response);
      let failure: unknown;
      try { await api.request("/ilink/bot/getupdates", { signal }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(IlinkError);
      expect(safeError(failure)).not.toContain("private-token-secret");
    }
  });

  it.each([
    { ...rawMessage, group_id: "a-group" },
    { ...rawMessage, message_type: 2 },
    { ...rawMessage, to_user_id: "another-bot" },
    { ...rawMessage, context_token: "" },
    { ...rawMessage, item_list: [{ type: 2 }] },
    { ...rawMessage, message_id: undefined },
  ])("ignores unsupported or unsafe inbound messages", message => {
    expect(inboundText(message, "bot")).toBeUndefined();
  });
});

describe("channel pipeline and local state", () => {
  it("binds the owner from a completed QR login without inferring identity from messages", async () => {
    const local = await state();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async url => Response.json(String(url).includes("get_bot_qrcode")
      ? { qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/fake-login" }
      : { status: "confirmed", bot_token: credentials.token, ilink_bot_id: "bot", ilink_user_id: "owner", baseurl: credentials.baseUrl })));
    const log = vi.fn();
    expect(await login(local, signal, { log, verifyCode: vi.fn() })).toEqual(credentials);
    expect(await local.credentials()).toEqual(credentials);
    expect(log.mock.calls.flat().join(" ")).not.toContain(credentials.token);
    expect(log.mock.calls.flat().join(" ")).not.toContain(credentials.ownerId);
  });

  it("refuses a successful login that lacks the authenticated owner", async () => {
    const local = await state();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async url => Response.json(String(url).includes("get_bot_qrcode")
      ? { qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/fake-login" }
      : { status: "confirmed", bot_token: credentials.token, ilink_bot_id: "bot", baseurl: credentials.baseUrl })));
    await expect(login(local, signal, { log: vi.fn(), verifyCode: vi.fn() })).rejects.toThrow("登录状态不完整");
    expect(await local.credentials()).toBeUndefined();
  });

  it("receives owner-only text, replies with original context and checkpoints after processing", async () => {
    const local = await state();
    const bodies: unknown[] = [];
    const endpoints: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      endpoints.push(path);
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(path.endsWith("getupdates") ? {
        ret: 0, msgs: [rawMessage, { ...rawMessage, message_id: "2", from_user_id: "stranger" }], get_updates_buf: "next-cursor",
      } : { ret: 0 });
    });
    const channel = new WeixinChannel(credentials, local, { pollTimeoutMs: 1000, requestTimeoutMs: 1000 }, new IlinkApi(credentials.baseUrl, fetcher));
    await channel.initialize();
    const messages = await channel.receive(signal);
    expect(messages).toHaveLength(1);
    expect(await local.cursor("bot")).toBe("");
    await new HelloApplication(channel, "owner", vi.fn()).handle(messages[0]!, signal);
    await channel.checkpoint();
    expect(endpoints).toEqual(["/ilink/bot/getupdates", "/ilink/bot/sendmessage"]);
    expect(bodies[1]).toMatchObject({ msg: { to_user_id: "owner", context_token: "fake-reply-token", message_type: 2,
      message_state: 2, item_list: [{ type: 1, text_item: { text: "收到" } }] } });
    expect(await local.cursor("bot")).toBe("next-cursor");
    await expect(channel.sendReply(messages[0]!.replyHandle, "收到", signal)).rejects.toThrow();
    expect(await readFile(join(local.directory, "cursor.json"), "utf8")).not.toContain("你好");
  });

  it.each([
    { response: { ret: 0 }, status: "accepted" },
    { response: { errcode: 0 }, status: "accepted" },
    { response: {}, status: "submitted" },
  ])("distinguishes optional acknowledgements from submission: $status", async ({ response, status }) => {
    const local = await state();
    const api = new IlinkApi(credentials.baseUrl, async url => Response.json(String(url).includes("getupdates") ? { ret: 0, msgs: [rawMessage] } : response));
    const channel = new WeixinChannel(credentials, local, { pollTimeoutMs: 1000, requestTimeoutMs: 1000 }, api);
    const [message] = await channel.receive(signal);
    await expect(channel.sendReply(message!.replyHandle, "收到", signal)).resolves.toEqual({ status });
  });

  it("stops polling on an invalid account session", async () => {
    const channel = new WeixinChannel(credentials, await state(), { pollTimeoutMs: 1000, requestTimeoutMs: 1000 },
      new IlinkApi(credentials.baseUrl, async () => Response.json({ ret: -14 })));
    await expect(channel.receive(signal)).rejects.toMatchObject({ name: "ChannelAuthenticationError" });
  });

  it("persists login only, resets the cursor on login and excludes other bot cursors", async () => {
    const local = await state();
    await local.saveCredentials(credentials);
    await local.saveCursor("bot", "old");
    expect(await local.cursor("other-bot")).toBe("");
    await local.saveCredentials(credentials);
    expect(await local.credentials()).toEqual(credentials);
    expect(await local.cursor("bot")).toBe("");
    expect((await readdir(local.directory)).sort()).toEqual(["credentials.json", "cursor.json"]);
    expect(() => parseCredentials({ ...credentials, ownerId: "" })).toThrow();
  });

  it("prevents multiple bot instances and allows restart after unlocking", async () => {
    const local = await state();
    const unlock = await local.lock();
    await expect(local.lock()).rejects.toThrow("已在运行");
    await unlock();
    const secondUnlock = await local.lock();
    await secondUnlock();
  });
});
