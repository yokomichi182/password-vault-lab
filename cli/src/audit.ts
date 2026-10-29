// パスワード漏れの監査(設計書 §14)。pwm audit と MCP の audit が同じものを使う。
// 1項目の判定は拡張の checkBreach をそのまま使う(ログイン用かどうかの判定も isLoginType に任せる)。
// 送るのは SHA-1 の先頭 5 文字だけ。結果はメモリの中だけに置き、保存しない。
import { checkBreach, type BreachResult } from "../../extension/src/shared/breach.ts";
import { CliError, type Ctx } from "./ctx.ts";
import { msg, type Lang } from "./i18n.ts";
import { fieldText, liveEntries, toCredential, type Kdbx } from "./kdbx.ts";

/** 本番の基点。 */
export const BREACH_BASE_URL = "https://api.pwnedpasswords.com";
/** 連続する要求の間隔(設計書 §14-3)。 */
export const MIN_INTERVAL_MS = 200;

const LOOPBACK_BASE_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/;

/**
 * 使う基点の URL を決める。PWM_BREACH_URL はテストのための差し替えで、受け付けるのは
 * http://127.0.0.1:<ポート> と http://localhost:<ポート>(パスなし)だけ。それ以外は無視せずエラーで止める。
 * エラーの文言に、与えられた値を入れない。
 */
export function resolveBreachBase(environ: Record<string, string | undefined>): string {
  const raw = environ.PWM_BREACH_URL;
  if (raw === undefined) return BREACH_BASE_URL;
  const m = LOOPBACK_BASE_RE.exec(raw);
  const port = m ? Number(m[1]) : 0;
  if (!m || port < 1 || port > 65535) throw new CliError("badBreachUrl");
  return raw;
}

export interface AuditResult {
  /** 漏洩済み(項目名と出現回数) */
  pwned: { title: string; count: number }[];
  clean: number;
  /** 通信できない、応答を読めない。「漏洩なし」ではない */
  skipped: number;
  /** API キー、知らない種類、パスワードが空 */
  notApplicable: number;
}

export interface AuditDeps {
  baseUrl: string;
  fetch: typeof fetch;
  /** 要求の間の待ち(テストで差し替える) */
  sleep: (ms: number) => Promise<void>;
}

export function auditDeps(ctx: Ctx): AuditDeps {
  return { baseUrl: resolveBreachBase(ctx.environ), fetch: ctx.fetch, sleep: (ms) => ctx.sleep(ms) };
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 先頭5文字(16進)の URL だけを数える。応答の本文は1回の監査の中だけで使い回す(メモリの中だけ)。 */
function pacedFetch(deps: AuditDeps): typeof fetch {
  const cache = new Map<string, string>();
  let sentBefore = false;
  return async (input, init) => {
    const url = String(input);
    const prefix = url.slice(url.lastIndexOf("/") + 1);
    const cached = cache.get(prefix);
    if (cached !== undefined) return new Response(cached, { status: 200 });
    // 実際に要求を送るときは、前の要求から 200ms 以上空ける
    if (sentBefore) await deps.sleep(MIN_INTERVAL_MS);
    sentBefore = true;
    const response = await deps.fetch(input, init);
    if (!response.ok) return response;
    const text = await response.text();
    cache.set(prefix, text);
    return new Response(text, { status: 200 });
  };
}

/** 開いた保管庫の全項目(ごみ箱の中を除く)を調べる。 */
export async function auditVault(db: Kdbx, deps: AuditDeps): Promise<AuditResult> {
  const targets = liveEntries(db).map((e) => {
    const c = toCredential(e);
    return { title: fieldText(e.fields.get("Title")), itemType: c.type, password: c.password };
  });
  const result: AuditResult = { pwned: [], clean: 0, skipped: 0, notApplicable: 0 };
  const paced = pacedFetch(deps);
  for (const t of targets) {
    const r: BreachResult = await checkBreach({ itemType: t.itemType, password: t.password }, deps.baseUrl, paced);
    if (r.status === "pwned") result.pwned.push({ title: t.title, count: r.count });
    else if (r.status === "clean") result.clean += 1;
    else if (r.status === "error") result.skipped += 1;
    else result.notApplicable += 1;
  }
  return result;
}

export function auditExitCode(r: AuditResult): number {
  if (r.pwned.length > 0) return 3;
  if (r.skipped > 0) return 2;
  return 0;
}

/** 表示用に、項目名の制御文字(改行・タブなど)を空白にする。 */
function plainTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** 標準出力の文面。出すのは項目名と回数と件数まで。 */
export function formatAudit(r: AuditResult, lang: Lang): string {
  const lines: string[] = [];
  if (r.pwned.length > 0) {
    lines.push(msg(lang, "auditPwnedHeader"));
    for (const p of r.pwned) lines.push(`  ${plainTitle(p.title)}\t${p.count}`);
  }
  lines.push(
    msg(lang, "auditSummary", {
      checked: r.pwned.length + r.clean + r.skipped,
      pwned: r.pwned.length,
      clean: r.clean,
      skipped: r.skipped,
      notApplicable: r.notApplicable,
    }),
  );
  if (r.skipped > 0) lines.push(msg(lang, "auditSkippedNote"));
  return lines.join("\n") + "\n";
}

/** 保存のあとの1回のチェック。保存は取り消さず、結果は標準エラーで知らせるだけ(設計書 §14-3)。例外は外に出さない。 */
export async function checkAfterSave(ctx: Ctx, db: Kdbx, title: string): Promise<void> {
  try {
    const base = resolveBreachBase(ctx.environ);
    const hits = liveEntries(db).filter((e) => fieldText(e.fields.get("Title")) === title);
    if (hits.length !== 1) return;
    const c = toCredential(hits[0]!);
    const r = await checkBreach({ itemType: c.type, password: c.password }, base, ctx.fetch);
    if (r.status === "pwned") ctx.err(msg(ctx.lang, "postSavePwned", { count: r.count }) + "\n");
    else if (r.status === "error") ctx.err(msg(ctx.lang, "postSaveSkipped") + "\n");
  } catch (e) {
    if (e instanceof CliError) ctx.err(`pwm: ${e.text(ctx.lang)}\n`);
    else ctx.err(msg(ctx.lang, "postSaveSkipped") + "\n");
  }
}
