// 全テスト共通の安全網: 実在の Pwned Passwords API(api.pwnedpasswords.com)には、どのテストからも要求を送らせない。
// テストは差し替えた fetch か、127.0.0.1 のモックサーバーだけを使う(AGENTS.md)。
const realFetch = globalThis.fetch;

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // URL として読めないものは、そのまま本物に任せる(失敗する)
  }
  if (host === "pwnedpasswords.com" || host.endsWith(".pwnedpasswords.com")) {
    return Promise.reject(new Error("tests must not call the real Pwned Passwords API"));
  }
  return realFetch(input, init);
}) as typeof fetch;
