// request_credential のテスト用の部品: 本体と自動処理用の2つの保管庫を同期先のモックに置いた PWM_HOME、台本どおりに動くダイアログ。
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTokenVault } from "../../extension/src/shared/vault.ts";
import type { ApprovalChoice, ApprovalDialog, ApprovalRequest, UnlockedInfo } from "../src/main/approveDialog.ts";
import { FILES } from "../src/store.ts";
import type { MockSync } from "./mockSync.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, makeHome, makeKdbx, type Home, type TestItem } from "./helpers.ts";

export const TOKEN_AUTOM = `${CANARY_AUTOM}-tok-approve-auto`;
export const TOKEN_MAIN = `${CANARY_MAIN}-tok-approve-main`;

let seq = 0;

export interface ApproveWorld {
  home: Home;
  autoVault: string;
  mainVault: string;
}

/** 本体の保管庫(マスターパスワードで開く)と自動処理用の保管庫(キーファイルで開く)を、同期先のモックとローカルの両方に置く。 */
export async function makeWorld(
  mock: MockSync,
  mainItems: TestItem[],
  autoItems: TestItem[] = [{ title: "seed", password: `${CANARY_AUTOM}-seed` }],
  opts: { withMain?: boolean } = {},
): Promise<ApproveWorld> {
  seq += 1;
  const autoVault = `ap-a${seq}`;
  const mainVault = `ap-m${seq}`;
  mock.tokens.set(`${TOKEN_AUTOM}-${seq}`, autoVault);
  mock.tokens.set(`${TOKEN_MAIN}-${seq}`, mainVault);
  const home = await makeHome(autoItems, { token: `${TOKEN_AUTOM}-${seq}`, syncUrl: mock.url, vault: autoVault });
  mock.setVault(autoVault, new Uint8Array(await readFile(path.join(home.dir, FILES.automationKdbx))));
  if (opts.withMain !== false) {
    mock.setVault(mainVault, await makeKdbx({ master: MASTER }, mainItems));
    await writeFile(path.join(home.dir, "main.token.kdbx"), await createTokenVault(MASTER, `${TOKEN_MAIN}-${seq}`));
    await writeFile(path.join(home.dir, FILES.config), JSON.stringify({ syncUrl: mock.url, automationVault: autoVault, mainVault }));
  }
  return { home, autoVault, mainVault };
}

export interface DialogScript {
  /** 入れるマスターパスワード。undefined なら 1段目で拒否する */
  master?: string;
  /** 2段目で押すボタン */
  choice?: ApprovalChoice;
}

/** 台本どおりに動くダイアログ。見せられた内容(値は入らない)を記録する。 */
export class ScriptedDialog implements ApprovalDialog {
  calls = 0;
  requests: ApprovalRequest[] = [];
  unlocked: (UnlockedInfo | null)[] = [];
  constructor(public script: DialogScript) {}

  async ask(req: ApprovalRequest, unlock: (master: string) => Promise<UnlockedInfo | null>): Promise<ApprovalChoice> {
    this.calls += 1;
    this.requests.push(req);
    if (this.script.master === undefined) return "deny";
    const info = await unlock(this.script.master);
    this.unlocked.push(info);
    return info ? (this.script.choice ?? "deny") : "deny";
  }
}
