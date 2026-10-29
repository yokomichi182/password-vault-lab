import { spawn } from "node:child_process";
import { CliError, type Protector } from "./ctx.ts";

// Windows PowerShell 5.1 の [System.Security.Cryptography.ProtectedData](範囲は CurrentUser)を子プロセスで呼ぶ。
// 値は標準入力(1行目: 動作、2行目: entropy の base64、3行目: 値の base64)で渡し、標準出力の base64 で受け取る。
// コマンドの引数に載せるのは、値を含まない固定のスクリプト(-EncodedCommand)だけ。
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $lines = [Console]::In.ReadToEnd() -split "\\r?\\n"
  $mode = $lines[0].Trim()
  $entropy = [Convert]::FromBase64String($lines[1].Trim())
  $data = [Convert]::FromBase64String($lines[2].Trim())
  if ($mode -eq 'protect') {
    $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($mode -eq 'unprotect') {
    $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    exit 3
  }
  [Console]::Out.Write([Convert]::ToBase64String($out))
  exit 0
} catch {
  exit 2
}
`;

const ENCODED_SCRIPT = Buffer.from(SCRIPT, "utf16le").toString("base64");

function callPowerShell(mode: "protect" | "unprotect", data: Uint8Array, entropy: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT], {
        stdio: ["pipe", "pipe", "ignore"], // 標準エラーは捨てる(メッセージを出さない)
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve({ code: 127, out: "" });
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", () => resolve({ code: 127, out: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(chunks).toString("ascii").trim() }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${mode}\n${Buffer.from(entropy, "utf8").toString("base64")}\n${Buffer.from(data).toString("base64")}\n`);
  });
}

export const windowsDpapi: Protector = {
  async protect(data, entropy) {
    const r = await callPowerShell("protect", data, entropy);
    if (r.code !== 0 || r.out === "") throw new CliError("dpapiProtect", { code: r.code });
    return new Uint8Array(Buffer.from(r.out, "base64"));
  },
  async unprotect(data, entropy) {
    const r = await callPowerShell("unprotect", data, entropy);
    if (r.code !== 0 || r.out === "") throw new CliError("dpapiOpen", { code: r.code });
    return new Uint8Array(Buffer.from(r.out, "base64"));
  },
};
