/**
 * L3 — Local channel credentials, cursor and process ownership.
 * Input: project-local data directory and validated channel state.
 * Output: local state; no private chat content is retained.
 * Pos: Weixin channel persistence; see ./L2.md.
 * Effects/Dependencies: writes ignored .weave files, atomic replacement, process lock.
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord, validatedApiUrl } from "./api.ts";

export interface Credentials {
  token: string;
  botId: string;
  ownerId: string;
  baseUrl: string;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseCredentials(value: unknown): Credentials {
  if (!isRecord(value) || !nonempty(value.token) || !nonempty(value.botId) ||
      !nonempty(value.ownerId) || !nonempty(value.baseUrl)) {
    throw new Error("登录状态不完整，请重新运行 npm run login。");
  }
  return { token: value.token, botId: value.botId, ownerId: value.ownerId, baseUrl: validatedApiUrl(value.baseUrl) };
}

export class ChannelState {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async read(name: string): Promise<unknown | undefined> {
    try { return JSON.parse(await readFile(join(this.directory, name), "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("本地渠道状态无法读取，请检查 .weave 目录；不要将凭据发到聊天中。");
    }
  }

  private async write(name: string, value: unknown): Promise<void> {
    await this.ensureDirectory();
    const temporary = join(this.directory, `${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, name));
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async credentials(): Promise<Credentials | undefined> {
    const value = await this.read("credentials.json");
    return value === undefined ? undefined : parseCredentials(value);
  }

  async saveCredentials(credentials: Credentials): Promise<void> {
    await this.write("credentials.json", parseCredentials(credentials));
    // Cursor belongs to a particular login, never to another bot account.
    await this.write("cursor.json", { botId: credentials.botId, cursor: "" });
  }

  async cursor(botId: string): Promise<string> {
    const value = await this.read("cursor.json");
    return isRecord(value) && value.botId === botId && typeof value.cursor === "string" ? value.cursor : "";
  }

  async saveCursor(botId: string, cursor: string): Promise<void> {
    await this.write("cursor.json", { botId, cursor });
  }

  async lock(): Promise<() => Promise<void>> {
    await this.ensureDirectory();
    const path = join(this.directory, "instance.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.close();
        return async () => { await unlink(path).catch(() => {}); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const value = await this.read("instance.lock");
        if (!isRecord(value) || !Number.isInteger(value.pid) || (value.pid as number) <= 0) {
          throw new Error("进程锁异常，请检查 .weave/instance.lock。");
        }
        try { process.kill(value.pid as number, 0); }
        catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
            await unlink(path);
            continue;
          }
        }
        throw new Error("Weave 已在运行，请先关闭已有进程。");
      }
    }
    throw new Error("无法取得 Weave 进程锁。");
  }
}
