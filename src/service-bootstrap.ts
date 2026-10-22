/**
 * L3 — Real API service composition, independent from input channel.
 * Input: optional validated API config/environment/HTTP transport and log.
 * Output: ServiceRouter over an independent model and the real ChatService.
 * Pos: composition root helper; see ./L2.md.
 * Effects/Dependencies: loads ignored local keys or named environment fallbacks;
 * requests occur on run(). Config and secret values are never logged.
 */
import type { Log } from "./contracts.ts";
import type { ServiceConfig } from "./service-config.ts";
import { ServiceRouter } from "./router/router.ts";

export async function buildServices(log: Log, options: {
  config?: ServiceConfig; environment?: Record<string, string | undefined>; fetch?: typeof fetch;
} = {}): Promise<ServiceRouter> {
  const { loadServiceConfig } = await import("./service-config.ts");
  const config = options.config ?? await loadServiceConfig();
  const environment = options.environment ?? process.env;
  const key = (role: "router" | "chat") => {
    const value = config[role].apiKey?.trim() || config.apiKey.trim() || environment[config[role].apiKeyEnv]?.trim();
    if (!value) throw new Error(`缺少 ${role} 的 API Key，请在 services.config.local.json 填写 apiKey，或设置 ${config[role].apiKeyEnv}。`);
    return value;
  };
  const routerKey = key("router"), chatKey = key("chat");
  const { DeepSeekModel } = await import("./model/deepseek.ts");
  const { DeepSeekClient } = await import("./chat/deepseek.ts");
  const { ChatService } = await import("./chat/service.ts");
  const { ApiRouteModel } = await import("./router/model.ts");
  const clientOptions = (role: "router" | "chat", apiKey: string) => ({ apiKey, model: config[role].model,
    requestTimeoutMs: config[role].requestTimeoutMs, thinkingTimeoutMs: config[role].thinkingTimeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}) });
  const routingModel = new DeepSeekModel({ ...clientOptions("router", routerKey), maxRetries: 0 });
  const chat = new DeepSeekClient(clientOptions("chat", chatKey));
  return new ServiceRouter(new ApiRouteModel(routingModel), [{ id: "chat",
    description: "聊天、翻译、解释与资料搜索问答；不实际操作文件、执行命令或部署。", service: new ChatService(chat, chat) }],
  log, config.router.requestTimeoutMs);
}
