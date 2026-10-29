// request_credential の子のプロセス(pwm.mjs approve-credential)と pwm-mcp のあいだの取り決め。
// pwm-mcp の束に入るので、本体の保管庫に関するものは import しない(設計書 §11-2、AGENTS.md の決まり7)。

export const CLIENT_NAME_MAX = 64;

/** 要求した AI の名前(自己申告)を表示用にそろえる。制御文字は空白にし、64文字で切る。 */
export function sanitizeClientName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  const cut = Array.from(flat).slice(0, CLIENT_NAME_MAX).join("").trim();
  return cut === "" ? "(unknown)" : cut;
}

/** ユーザー名の一部。先頭2文字のあとを … にする。2文字以下なら … だけ。 */
export function usernameHint(username: string): string {
  const chars = Array.from(username);
  return chars.length <= 2 ? "…" : chars.slice(0, 2).join("") + "…";
}

/** 表示用に制御文字を空白にして、長すぎる項目名を切る。 */
export function displayText(raw: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : flat;
}

export type BreachSummary =
  | { status: "pwned"; count: number }
  | { status: "clean" }
  | { status: "skipped" }
  | { status: "notApplicable" };

/** 複製に失敗した理由の種類。値の中身は入れない。 */
export const COPY_FAILURES = ["offline", "rejected", "auth", "conflict", "notConfigured", "duplicate", "cannotOpen", "empty", "error"] as const;
export type CopyFailure = (typeof COPY_FAILURES)[number];

export interface CredentialPayload {
  username: string;
  password: string;
  url: string;
  notes: string;
  type: string;
  environment: string;
  expires: string;
}

export const FAILURE_RESULTS = ["denied", "not_found", "busy", "unavailable"] as const;
export type FailureResult = (typeof FAILURE_RESULTS)[number];

export type ApproveOutcome =
  | {
      result: "ok";
      credential: CredentialPayload;
      /** 自動処理用の保管庫に残さず、この1回だけ返した */
      returnedOnce: boolean;
      copied: boolean;
      copyFailure?: CopyFailure;
      breach?: BreachSummary;
    }
  | { result: FailureResult };

const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * 子のプロセスの標準出力(JSON の1行)を確かめて読む。形が違うものは unavailable にする。
 * 本物の応答であっても、知らない欄は捨てる。
 */
export function parseApproveOutput(text: string): ApproveOutcome {
  const bad: ApproveOutcome = { result: "unavailable" };
  let j: unknown;
  try {
    j = JSON.parse(text.trim().split("\n")[0] ?? "");
  } catch {
    return bad;
  }
  if (typeof j !== "object" || j === null) return bad;
  const o = j as Record<string, unknown>;
  if ((FAILURE_RESULTS as readonly unknown[]).includes(o.result)) return { result: o.result as FailureResult };
  if (o.result !== "ok") return bad;
  const c = o.credential as Record<string, unknown> | undefined;
  if (typeof c !== "object" || c === null) return bad;
  const fields = ["username", "password", "url", "notes", "type", "environment", "expires"] as const;
  for (const f of fields) if (!isStr(c[f])) return bad;
  if (typeof o.returnedOnce !== "boolean" || typeof o.copied !== "boolean") return bad;
  const out: Extract<ApproveOutcome, { result: "ok" }> = {
    result: "ok",
    credential: {
      username: c.username as string,
      password: c.password as string,
      url: c.url as string,
      notes: c.notes as string,
      type: c.type as string,
      environment: c.environment as string,
      expires: c.expires as string,
    },
    returnedOnce: o.returnedOnce,
    copied: o.copied,
  };
  if ((COPY_FAILURES as readonly unknown[]).includes(o.copyFailure)) out.copyFailure = o.copyFailure as CopyFailure;
  const b = o.breach as Record<string, unknown> | undefined;
  if (b && typeof b === "object") {
    if (b.status === "pwned" && typeof b.count === "number" && Number.isFinite(b.count)) out.breach = { status: "pwned", count: b.count };
    else if (b.status === "clean" || b.status === "skipped" || b.status === "notApplicable") out.breach = { status: b.status };
  }
  return out;
}

/** AI に返す JSON。成功は read_credential と同じ形に returnedOnce と copied(と、あれば copyFailure、breach)を足したもの。 */
export function toToolPayload(o: ApproveOutcome): Record<string, unknown> {
  if (o.result !== "ok") return { result: o.result };
  const p: Record<string, unknown> = { ...o.credential, returnedOnce: o.returnedOnce, copied: o.copied };
  if (o.copyFailure) p.copyFailure = o.copyFailure;
  if (o.breach) p.breach = o.breach;
  return p;
}
