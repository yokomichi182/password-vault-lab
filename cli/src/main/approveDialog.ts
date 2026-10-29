// request_credential の承認ダイアログ(Windows PowerShell 5.1 の WinForms を子のプロセスで出す。DPAPI・トーストと同じ呼び方)。
// 本体の保管庫を開くプロセス(pwm.mjs approve-credential)の中だけで使う。pwm-mcp の束には入れない(AGENTS.md の決まり7)。
//
// ダイアログは1つの窓で2段に進む。
//   1段目: 項目名、要求した AI の名前(自己申告)、時刻、マスターパスワードの欄。「解除して内容を確認」か「拒否」。
//   2段目: 本体の保管庫が開けて項目が見つかったあと、種類とユーザー名の一部を出し、3つのボタン(今回だけ返す / 複製して返す / 拒否)を出す。
// マスターパスワードは、PowerShell から node へ標準出力の1行(base64)で渡す。引数、環境変数、ファイルには載せない。
// 項目の種類とユーザー名の一部は、マスターパスワードで開かないと分からないので、2段にした(設計書・指示にない判断。報告で持ち上げる)。
import { spawn } from "node:child_process";
import type { Lang } from "../i18n.ts";

export interface ApprovalRequest {
  title: string;
  client: string;
  /** 表示用の時刻(今の PC のタイムゾーン) */
  time: string;
  lang: Lang;
  timeoutSec: number;
}

export interface UnlockedInfo {
  type: string;
  userHint: string;
}

export type ApprovalChoice = "once" | "copy" | "deny";

/**
 * 承認ダイアログ。unlock は、利用者が入れたマスターパスワードで本体の保管庫を開いて項目を探す。
 * 開けない・項目がないときは null を返す(ダイアログは閉じて deny を返す)。マスターパスワードは unlock に渡すだけで、ほかに持たない。
 */
export interface ApprovalDialog {
  ask(req: ApprovalRequest, unlock: (master: string) => Promise<UnlockedInfo | null>): Promise<ApprovalChoice>;
}

export const DIALOG_TIMEOUT_SEC = 120;
/** 親が待つ上限(ダイアログ自身の時間切れより少し長く) */
const WATCHDOG_MS = (DIALOG_TIMEOUT_SEC + 15) * 1000;

const TEXT = {
  windowTitle: { en: "pwm - approval request", ja: "pwm - 承認の依頼" },
  heading: {
    en: "An AI client is asking for one item from your main vault.",
    ja: "AI が、本体の保管庫の項目を1つ求めています。",
  },
  capTitle: { en: "Item", ja: "項目名" },
  capType: { en: "Type", ja: "種類" },
  capUser: { en: "User name", ja: "ユーザー名" },
  capClient: { en: "Requested by", ja: "要求元" },
  capTime: { en: "Time", ja: "時刻" },
  selfReported: { en: " (self-reported)", ja: " (自己申告)" },
  masterLabel: { en: "Master password:", ja: "マスターパスワード:" },
  unknownYet: { en: "(shown after unlock)", ja: "(解除すると表示します)" },
  unlock: { en: "Unlock and review", ja: "解除して内容を確認" },
  once: { en: "Return once", ja: "今回だけ返す" },
  copy: { en: "Copy to automation vault, then return", ja: "自動処理用の保管庫に複製して返す" },
  deny: { en: "Deny", ja: "拒否" },
  working: { en: "Opening the vault...", ja: "保管庫を開いています..." },
  chooseHint: {
    en: "Return once: the value is not stored anywhere. Copy: it is added to the automation vault and can be read without approval from then on.",
    ja: "今回だけ返す: 値はどこにも残しません。複製して返す: 自動処理用の保管庫に足し、以後は承認なしで読めます。",
  },
  unlockHint: {
    en: "Enter your master password to review the item. Esc denies.",
    ja: "マスターパスワードを入れると内容を確認できます。Esc で拒否します。",
  },
} as const;

type TextKey = keyof typeof TEXT;
const t = (lang: Lang, key: TextKey): string => TEXT[key][lang];

// 固定のスクリプト(値を含まない)。表示する文言は標準入力の1行目(UTF-8 の JSON の base64)で渡す。
// 以後の標準入力は node からの応答の行、標準出力は PowerShell からの行:
//   U <マスターパスワードの base64>   → 応答 OK <JSON の base64> か NG
//   R once|copy|deny                  → 最後の行
export const DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $first = [Console]::In.ReadLine()
  $req = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($first.Trim())) | ConvertFrom-Json
  $script:answer = 'deny'

  $form = New-Object System.Windows.Forms.Form
  $form.Text = $req.windowTitle
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.ClientSize = New-Object System.Drawing.Size(520, 372)
  $form.Font = New-Object System.Drawing.Font('Yu Gothic UI', 9.5)

  function New-Label($text, $x, $y, $w, $h) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, $h)
    $l.AutoEllipsis = $true
    $form.Controls.Add($l)
    return $l
  }

  $heading = New-Label $req.heading 16 14 488 40
  $heading.Font = New-Object System.Drawing.Font('Yu Gothic UI', 10.5, [System.Drawing.FontStyle]::Bold)
  $heading.AutoEllipsis = $false
  [void](New-Label $req.capTitle 16 66 120 22)
  $titleValue = New-Label $req.title 140 66 364 22
  [void](New-Label $req.capType 16 94 120 22)
  $typeValue = New-Label $req.unknownYet 140 94 364 22
  [void](New-Label $req.capUser 16 122 120 22)
  $userValue = New-Label $req.unknownYet 140 122 364 22
  [void](New-Label $req.capClient 16 150 120 22)
  $clientValue = New-Label ($req.client + $req.selfReported) 140 150 364 22
  [void](New-Label $req.capTime 16 178 120 22)
  $timeValue = New-Label $req.time 140 178 364 22

  $masterCaption = New-Label $req.masterLabel 16 216 488 22
  $master = New-Object System.Windows.Forms.TextBox
  $master.UseSystemPasswordChar = $true
  $master.Location = New-Object System.Drawing.Point(16, 240)
  $master.Size = New-Object System.Drawing.Size(488, 26)
  $form.Controls.Add($master)

  $note = New-Label $req.unlockHint 16 274 488 44
  $note.AutoEllipsis = $false

  $unlock = New-Object System.Windows.Forms.Button
  $unlock.Text = $req.unlock
  $unlock.Location = New-Object System.Drawing.Point(16, 326)
  $unlock.Size = New-Object System.Drawing.Size(200, 34)
  $form.Controls.Add($unlock)

  $once = New-Object System.Windows.Forms.Button
  $once.Text = $req.once
  $once.Location = New-Object System.Drawing.Point(16, 326)
  $once.Size = New-Object System.Drawing.Size(130, 34)
  $once.Visible = $false
  $form.Controls.Add($once)

  $copy = New-Object System.Windows.Forms.Button
  $copy.Text = $req.copy
  $copy.Location = New-Object System.Drawing.Point(154, 326)
  $copy.Size = New-Object System.Drawing.Size(268, 34)
  $copy.Visible = $false
  $form.Controls.Add($copy)

  $deny = New-Object System.Windows.Forms.Button
  $deny.Text = $req.deny
  $deny.Location = New-Object System.Drawing.Point(430, 326)
  $deny.Size = New-Object System.Drawing.Size(74, 34)
  $form.Controls.Add($deny)

  $form.AcceptButton = $unlock
  $form.CancelButton = $deny

  $deny.Add_Click({ $script:answer = 'deny'; $form.Close() })
  $once.Add_Click({ $script:answer = 'once'; $form.Close() })
  $copy.Add_Click({ $script:answer = 'copy'; $form.Close() })

  $unlock.Add_Click({
    $unlock.Enabled = $false
    $master.Enabled = $false
    $deny.Enabled = $false
    $note.Text = $req.working
    $form.Refresh()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($master.Text)
    $master.Text = ''
    [Console]::Out.WriteLine('U ' + [Convert]::ToBase64String($bytes))
    [Console]::Out.Flush()
    [Array]::Clear($bytes, 0, $bytes.Length)
    $line = [Console]::In.ReadLine()
    if ($line -ne $null -and $line.StartsWith('OK ')) {
      $info = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(3))) | ConvertFrom-Json
      $typeValue.Text = $info.type
      $userValue.Text = $info.userHint
      $masterCaption.Visible = $false
      $master.Visible = $false
      $unlock.Visible = $false
      $note.Text = $req.chooseHint
      $once.Visible = $true
      $copy.Visible = $true
      $deny.Enabled = $true
      $form.AcceptButton = $once
      $once.Focus()
    } else {
      $script:answer = 'deny'
      $form.Close()
    }
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [int]$req.timeoutSec * 1000
  $timer.Add_Tick({ $script:answer = 'deny'; $form.Close() })
  $timer.Start()

  $form.Add_Shown({
    $form.Activate()
    $master.Focus()
    # @@SHOWN@@
  })
  [void]$form.ShowDialog()
  $timer.Stop()
  [Console]::Out.WriteLine('R ' + $script:answer)
  [Console]::Out.Flush()
  exit 0
} catch {
  exit 2
}
`;

const ENCODED_SCRIPT = Buffer.from(DIALOG_SCRIPT, "utf16le").toString("base64");

export function requestJson(req: ApprovalRequest): string {
  const l = req.lang;
  return JSON.stringify({
    windowTitle: t(l, "windowTitle"),
    heading: t(l, "heading"),
    capTitle: t(l, "capTitle"),
    capType: t(l, "capType"),
    capUser: t(l, "capUser"),
    capClient: t(l, "capClient"),
    capTime: t(l, "capTime"),
    selfReported: t(l, "selfReported"),
    masterLabel: t(l, "masterLabel"),
    unknownYet: t(l, "unknownYet"),
    unlock: t(l, "unlock"),
    once: t(l, "once"),
    copy: t(l, "copy"),
    deny: t(l, "deny"),
    working: t(l, "working"),
    chooseHint: t(l, "chooseHint"),
    unlockHint: t(l, "unlockHint"),
    title: req.title,
    client: req.client,
    time: req.time,
    timeoutSec: req.timeoutSec,
  });
}

/** 本物のダイアログ。PowerShell を起動できないときは例外(呼び出し側が unavailable にする)。 */
export const windowsApprovalDialog: ApprovalDialog = {
  ask(req, unlock) {
    return new Promise<ApprovalChoice>((resolve, reject) => {
      let child;
      try {
        child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", ENCODED_SCRIPT], {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          shell: false,
        });
      } catch {
        reject(new Error("dialog spawn failed"));
        return;
      }
      let settled = false;
      let unlockUsed = false;
      let choice: ApprovalChoice = "deny";
      let buf = "";
      const finish = (c: ApprovalChoice): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(c);
      };
      const watchdog = setTimeout(() => {
        child.kill();
        finish("deny");
      }, WATCHDOG_MS);
      const reply = (line: string): void => void child.stdin.write(line + "\n");

      const onLine = (line: string): void => {
        if (line.startsWith("U ")) {
          if (unlockUsed) return reply("NG"); // 試せるのは1回だけ
          unlockUsed = true;
          const bytes = Buffer.from(line.slice(2).trim(), "base64");
          const master = bytes.toString("utf8");
          bytes.fill(0);
          unlock(master)
            .then((info) => {
              reply(info ? "OK " + Buffer.from(JSON.stringify(info), "utf8").toString("base64") : "NG");
            })
            .catch(() => reply("NG"));
        } else if (line.startsWith("R ")) {
          const v = line.slice(2).trim();
          choice = v === "once" || v === "copy" ? v : "deny";
        }
      };
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("ascii");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          onLine(line);
        }
      });
      child.on("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          reject(new Error("dialog spawn failed"));
        }
      });
      child.on("close", () => finish(choice));
      child.stdin.on("error", () => undefined);
      child.stdin.write(Buffer.from(requestJson(req), "utf8").toString("base64") + "\n");
    });
  },
};
