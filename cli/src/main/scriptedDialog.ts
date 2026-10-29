// テスト用の承認ダイアログの差し替え。テスト用のビルド(dist/test/、__PWM_TEST_DIALOG_ENV__ が空でない)でだけ読み込まれる。通常のビルドには入らない。
import { readFile, writeFile } from "node:fs/promises";
import type { ApprovalChoice, ApprovalDialog } from "./approveDialog.ts";

export interface ScriptedDialogSpec {
  /** 入れるマスターパスワード。無ければ、1段目で拒否する */
  master?: string;
  /** 2段目で押すボタン */
  choice?: ApprovalChoice;
  /** 押すまでの待ち(ミリ秒)。同時の要求と時間切れのテスト用 */
  delayMs?: number;
}

/** 台本のファイル(JSON)に従うダイアログ。出した内容は `<ファイル>.seen` に書く(値は入らない)。 */
export default function scriptedDialog(file: string): ApprovalDialog {
  return {
    async ask(req, unlock) {
      const spec = JSON.parse(await readFile(file, "utf8")) as ScriptedDialogSpec;
      const seen: Record<string, unknown> = { request: { title: req.title, client: req.client, time: req.time, lang: req.lang } };
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      if (spec.delayMs) await sleep(spec.delayMs);
      let result: ApprovalChoice = "deny";
      if (spec.master !== undefined) {
        const info = await unlock(spec.master);
        seen.unlocked = info;
        if (info) result = spec.choice ?? "deny";
      }
      seen.choice = result;
      await writeFile(file + ".seen", JSON.stringify(seen));
      return result;
    },
  };
}
