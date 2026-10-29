// pwm-mcp(または pwm fill)と、Native Messaging のホスト pwm-bridge のつなぎ(実装指示_フェーズ5 の 3-6)。
// ネットワークの待ち受けも名前付きパイプも開かない。<PWM_HOME>\bridge\ のファイル(依頼 req-<ID>.json、応答 res-<ID>.json)で受け渡す。
// ファイルに値は入らない。入れるのは、依頼の ID、項目名、url(あれば)、AI の名前、時刻だけ。
// pwm-mcp と pwm-bridge の両方の束に入るので、本体の保管庫・同期・通信に関するものは import しない。
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const BRIDGE_DIR = "bridge";
export const ID_RE = /^[0-9a-f]{32}$/;
export const REQ_RE = /^req-([0-9a-f]{32})\.json$/;
export const RES_RE = /^res-([0-9a-f]{32})\.json$/;
/** 依頼を待つ時間(pwm-mcp の側) */
export const FILL_WAIT_MS = 60_000;
/** この時間より古い依頼・応答は捨てる(pwm-bridge の側) */
export const STALE_MS = 90_000;
export const MAX_FILE_BYTES = 8 * 1024;
export const TITLE_MAX = 1024;
export const URL_MAX = 2048;

export const FILL_RESULTS = ["filled", "denied", "not_found", "locked", "unavailable"] as const;
export type FillResult = (typeof FILL_RESULTS)[number];

export interface FillRequest {
  v: 1;
  id: string;
  title: string;
  url?: string;
  client: string;
  /** 依頼を書いた時刻(ミリ秒) */
  at: number;
}

export function bridgeHome(environ: Record<string, string | undefined>): string {
  const fromEnv = environ.PWM_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  const local = environ.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is not set");
  return path.join(local, "pwm");
}

export const bridgeDir = (home: string): string => path.join(home, BRIDGE_DIR);
export const reqName = (id: string): string => `req-${id}.json`;
export const resName = (id: string): string => `res-${id}.json`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 依頼のファイルの中身を確かめる。形が違えば null。知らない欄は捨てる。 */
export function parseFillRequest(text: string, expectedId?: string): FillRequest | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j) || j.v !== 1) return null;
  const { id, title, url, client, at } = j;
  if (typeof id !== "string" || !ID_RE.test(id) || (expectedId !== undefined && id !== expectedId)) return null;
  if (typeof title !== "string" || title === "" || title.length > TITLE_MAX) return null;
  if (url !== undefined && (typeof url !== "string" || url.length > URL_MAX)) return null;
  if (typeof client !== "string" || client.length > 256) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const out: FillRequest = { v: 1, id, title, client, at };
  if (url !== undefined && url !== "") out.url = url;
  return out;
}

export function parseFillResponse(text: string, id: string): FillResult | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j) || j.v !== 1 || j.id !== id) return null;
  return (FILL_RESULTS as readonly unknown[]).includes(j.result) ? (j.result as FillResult) : null;
}

/** 一時ファイルに書いてから名前を変える(途中の内容を相手に読ませない)。一時ファイルは req-・res- で始めない。 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export interface FillOptions {
  home: string;
  title: string;
  url?: string;
  client: string;
  /** 応答を待つ上限(ミリ秒)。既定 60 秒 */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * request_fill の依頼を置いて、応答を待つ。応答が無ければ(時間切れ)unavailable。
 * 依頼と応答のファイルは、読み終えたら(または諦めたら)消す。
 */
export async function requestFill(opts: FillOptions): Promise<FillResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dir = bridgeDir(opts.home);
  const id = randomBytes(16).toString("hex");
  const req: FillRequest = { v: 1, id, title: opts.title, client: opts.client, at: now() };
  if (opts.url !== undefined && opts.url !== "") req.url = opts.url;
  const reqFile = path.join(dir, reqName(id));
  const resFile = path.join(dir, resName(id));
  try {
    await writeAtomic(reqFile, JSON.stringify(req));
    const deadline = now() + (opts.timeoutMs ?? FILL_WAIT_MS);
    for (;;) {
      const text = await readText(resFile);
      if (text !== null) {
        const r = parseFillResponse(text, id);
        return r ?? "unavailable";
      }
      if (now() >= deadline) return "unavailable";
      await sleep(opts.pollMs ?? 100);
    }
  } catch {
    return "unavailable";
  } finally {
    await rm(reqFile, { force: true }).catch(() => undefined);
    await rm(resFile, { force: true }).catch(() => undefined);
  }
}
