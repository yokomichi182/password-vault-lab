// pwm approve-credential: request_credential の承認ダイアログの子のプロセス(設計書 §11-2、実装指示_フェーズ5 の 3-1〜3-3)。
// 本体の保管庫を開くのは、このプロセスだけ(pwm-mcp の束には入れない。AGENTS.md の決まり7の例外)。
// 標準出力に書くのは JSON の1行だけ。端末から人が実行しても、必ずダイアログを通す。標準入力からマスターパスワードを受け取る道は作らない。
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ENVIRONMENT_FIELD, ITEM_TYPE_FIELD, ItemTypes } from "../../../extension/src/shared/constants.ts";
import { checkBreach } from "../../../extension/src/shared/breach.ts";
import {
  displayText,
  sanitizeClientName,
  usernameHint,
  type ApproveOutcome,
  type BreachSummary,
  type CopyFailure,
} from "../approve/protocol.ts";
import { resolveBreachBase } from "../audit.ts";
import { mutate } from "../commands/cmdAuto.ts";
import { parse } from "../commands/args.ts";
import { CliError, type Ctx } from "../ctx.ts";
import { kdbxweb, liveEntries, parseExpiry, toCredential, fieldText, type Credential } from "../kdbx.ts";
import { DIALOG_TIMEOUT_SEC, type ApprovalDialog } from "./approveDialog.ts";
import { hasMainSetup, openMainWithMaster } from "./mainVault.ts";

export interface ApproveDeps {
  dialog: ApprovalDialog;
}

const LOCK_FILE = "approve.lock";
/** この時間を過ぎた錠は、落ちたプロセスの残りとみなして外す(ダイアログの時間切れより長く) */
const LOCK_STALE_MS = 150_000;

/** 同時に出すダイアログは1つまで。取れなければ null。 */
async function acquireLock(home: string): Promise<(() => Promise<void>) | null> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(file, "wx");
      await h.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(file, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 今の PC のタイムゾーンの YYYY-MM-DD HH:mm:ss */
function timeText(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function copyFailureOf(e: unknown): CopyFailure {
  if (!(e instanceof CliError)) return "error";
  switch (e.key) {
    case "offlineNoWrite":
      return "offline";
    case "syncRejected":
      return "rejected";
    case "syncAuth":
      return "auth";
    case "conflictGiveUp":
      return "conflict";
    case "noAutomation":
      return "notConfigured";
    case "duplicateTitle":
      return "duplicate";
    case "cannotOpenServer":
    case "cannotOpen":
      return "cannotOpen";
    case "syncEmpty":
      return "empty";
    default:
      return "error";
  }
}

/** 自動処理用の保管庫に、本体の項目の写しを足す。UUID は新しく作る(本体の UUID は写さない)。 */
function addCopy(db: Parameters<Parameters<typeof mutate>[1]>[0], c: Credential): void {
  const exists = liveEntries(db).some((e) => fieldText(e.fields.get("Title")) === c.title);
  if (exists) throw new CliError("duplicateTitle");
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set("Title", c.title);
  e.fields.set("UserName", c.username);
  e.fields.set("Password", kdbxweb.ProtectedValue.fromString(c.password));
  e.fields.set("URL", c.url);
  if (c.notes !== "") e.fields.set("Notes", c.notes);
  if (c.type !== ItemTypes.PASSWORD) e.fields.set(ITEM_TYPE_FIELD, c.type); // password は属性を書かない
  if (c.environment !== "") e.fields.set(ENVIRONMENT_FIELD, c.environment);
  if (c.expires !== "") {
    e.times.expires = true;
    e.times.expiryTime = parseExpiry(c.expires);
  }
}

/** 複製したあとの1回の漏洩チェック(設計書 §14-3)。結果は種類だけ。 */
async function breachOf(ctx: Ctx, c: Credential): Promise<BreachSummary> {
  try {
    const r = await checkBreach({ itemType: c.type, password: c.password }, resolveBreachBase(ctx.environ), ctx.fetch);
    if (r.status === "pwned") return { status: "pwned", count: r.count };
    if (r.status === "clean") return { status: "clean" };
    if (r.status === "error") return { status: "skipped" };
    return { status: "notApplicable" };
  } catch {
    return { status: "skipped" };
  }
}

export async function cmdApproveCredential(ctx: Ctx, args: string[], deps: ApproveDeps): Promise<number> {
  const p = parse(args, { options: { title: { type: "string" }, client: { type: "string" } } });
  const title = p.values.title ?? "";
  if (title === "") throw new CliError("badTitle");
  const client = sanitizeClientName(p.values.client);
  const emit = (o: ApproveOutcome): number => {
    ctx.out(JSON.stringify(o) + "\n");
    return 0;
  };

  const release = await acquireLock(ctx.home);
  if (!release) return emit({ result: "busy" });
  try {
    if (!(await hasMainSetup(ctx))) return emit({ result: "unavailable" });

    let found: Credential | null = null;
    let failure: "denied" | "not_found" | "unavailable" = "denied";
    const unlock = async (master: string) => {
      const r = await openMainWithMaster(ctx, master);
      if (r.kind !== "ok") {
        failure = r.kind;
        return null;
      }
      const hits = liveEntries(r.db).filter((e) => fieldText(e.fields.get("Title")) === title);
      const c = hits.length === 1 ? toCredential(hits[0]!) : null;
      // 返してよい種類はパスワードと API キー。知らない種類と、2件以上の一致は返さない
      if (!c || (c.type !== ItemTypes.PASSWORD && c.type !== ItemTypes.APIKEY)) {
        failure = "not_found";
        return null;
      }
      found = c;
      return { type: c.type, userHint: usernameHint(c.username) };
    };

    let choice;
    try {
      choice = await deps.dialog.ask(
        { title: displayText(title), client, time: timeText(ctx.now()), lang: ctx.lang, timeoutSec: DIALOG_TIMEOUT_SEC },
        unlock,
      );
    } catch {
      return emit({ result: "unavailable" }); // ダイアログを出せなかった
    }
    const cred = found as Credential | null;
    if (choice === "deny" || cred === null) return emit({ result: failure });

    if (choice === "once") {
      return emit({ result: "ok", credential: payloadOf(cred), returnedOnce: true, copied: false });
    }

    // 複製してから返す。失敗したら、値を今回だけ返し、copied: false と理由の種類を返す
    const quiet: Ctx = { ...ctx, out: () => undefined, err: () => undefined };
    let breach: BreachSummary | undefined;
    try {
      await mutate(
        quiet,
        (db) => addCopy(db, cred),
        async () => {
          breach = await breachOf(ctx, cred);
        },
      );
    } catch (e) {
      return emit({ result: "ok", credential: payloadOf(cred), returnedOnce: true, copied: false, copyFailure: copyFailureOf(e) });
    }
    const out: ApproveOutcome = { result: "ok", credential: payloadOf(cred), returnedOnce: false, copied: true };
    if (breach) out.breach = breach;
    return emit(out);
  } finally {
    await release();
  }
}

function payloadOf(c: Credential) {
  return {
    username: c.username,
    password: c.password,
    url: c.url,
    notes: c.notes,
    type: c.type,
    environment: c.environment,
    expires: c.expires,
  };
}
