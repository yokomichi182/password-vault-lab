import { intersects, isOutsideDocument, isTooSmall, type Box } from "../shared/visible.ts";

// ログインの欄を探す。見えている欄だけを対象にする(設計書 §6、実装指示 3-5)。

function toDocBox(rect: DOMRect): Box {
  return {
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    right: rect.right + window.scrollX,
    bottom: rect.bottom + window.scrollY,
  };
}

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/**
 * 見えている欄か。次を除く: display:none、visibility:hidden、不透明度 0(自分と祖先)、大きさ 0、
 * 画面外(文書の範囲の外)、祖先に隠れているもの(大きさ 0 で切り取られている)、disabled と readonly。
 */
export function isVisibleField(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false;
  if (!input.isConnected) return false;
  if (typeof input.checkVisibility === "function") {
    // display:none(祖先を含む)、visibility:hidden、content-visibility、opacity:0(祖先を含む)を見る
    if (!input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  } else {
    const style = getComputedStyle(input);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  const rect = input.getBoundingClientRect();
  if (isTooSmall(toBox(rect))) return false;
  const doc = document.documentElement;
  if (isOutsideDocument(toDocBox(rect), { scrollWidth: doc.scrollWidth, scrollHeight: doc.scrollHeight })) return false;

  // 祖先の overflow で切り取られて見えなくなっているもの(高さ 0 の箱に入れて隠す形など)
  const own = toBox(rect);
  for (let node = input.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const parentRect = node.getBoundingClientRect();
    const box = toBox(parentRect);
    if (isTooSmall(box) || !intersects(own, box)) return false;
  }
  return true;
}

const TEXT_TYPES = new Set(["text", "email", "tel", ""]);

function isTextInput(input: HTMLInputElement): boolean {
  const type = (input.getAttribute("type") ?? "").toLowerCase();
  return TEXT_TYPES.has(type);
}

function autocompleteTokens(input: HTMLInputElement): string[] {
  return (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

export interface LoginFields {
  username: HTMLInputElement | null;
  password: HTMLInputElement;
}

/** ログインの欄を探す。見えているパスワード欄(autocomplete="new-password" は除く)と、その前にある文字入力欄。 */
export function findLoginFields(doc: Document = document): LoginFields | null {
  const passwords = [...doc.querySelectorAll<HTMLInputElement>('input[type="password" i]')].filter(
    (p) => !autocompleteTokens(p).includes("new-password") && isVisibleField(p),
  );
  const password = passwords[0];
  if (!password) return null;

  const scope: ParentNode = password.form ?? doc;
  const all = [...scope.querySelectorAll<HTMLInputElement>("input")];
  const idx = all.indexOf(password);
  const before = all
    .slice(0, idx < 0 ? 0 : idx)
    .filter((i) => i !== password && isTextInput(i) && isVisibleField(i) && !autocompleteTokens(i).includes("new-password"));
  const preferred = before.filter((i) => {
    const tokens = autocompleteTokens(i);
    return tokens.includes("username") || tokens.includes("email");
  });
  // username/email と宣言された欄を優先し、なければパスワード欄のすぐ前の文字入力欄
  const username = preferred.length > 0 ? preferred[preferred.length - 1]! : (before[before.length - 1] ?? null);
  return { username, password };
}

/** ネイティブの value の setter で入れてから input と change を出す(フレームワークの画面のため)。送信のボタンは押さない。 */
export function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function fillFields(fields: LoginFields, username: string, password: string): void {
  if (fields.username) setNativeValue(fields.username, username);
  setNativeValue(fields.password, password);
}
