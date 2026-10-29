import { describe, expect, it } from "vitest";
import { ENTROPY_AUTOMATION_KEY, ENTROPY_AUTOMATION_TOKEN } from "../src/ctx.ts";
import { windowsDpapi } from "../src/dpapi.ts";
import { CANARY_AUTOM } from "./helpers.ts";

// Windows の本物の DPAPI(PowerShell 5.1)。架空のバイト列だけを使う。
describe.skipIf(process.platform !== "win32")("8. DPAPI(Windows の本物)", () => {
  const plain = new Uint8Array(Buffer.from(`${CANARY_AUTOM}-dpapi-fake-bytes-\u0000ÿ-end`, "utf8"));

  it("架空のバイト列が往復し、守ったバイト列に元のバイト列が含まれない", async () => {
    const wrapped = await windowsDpapi.protect(plain, ENTROPY_AUTOMATION_KEY);
    expect(wrapped.length).toBeGreaterThan(plain.length);
    expect(Buffer.from(wrapped).includes(Buffer.from(CANARY_AUTOM))).toBe(false);
    expect(Buffer.from(wrapped).includes(Buffer.from(plain))).toBe(false);
    const back = await windowsDpapi.unprotect(wrapped, ENTROPY_AUTOMATION_KEY);
    expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
  });

  it("entropy が違えば開けない。失敗の文言に値が入らない", async () => {
    const wrapped = await windowsDpapi.protect(plain, ENTROPY_AUTOMATION_KEY);
    const err = await windowsDpapi.unprotect(wrapped, ENTROPY_AUTOMATION_TOKEN).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(String(err!.message)).not.toContain(CANARY_AUTOM);
    expect((err as { exitCode?: number }).exitCode).toBe(1);
  });
});
