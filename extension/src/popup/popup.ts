import { CLIPBOARD_CLEAR_MS } from "../shared/constants.ts";
import { t } from "../shared/i18n.ts";
import type {
  BreachResponse,
  FillResponse,
  ListResponse,
  ListedItem,
  OkResponse,
  PopupRequest,
  StateResponse,
  UnlockResponse,
} from "../shared/messages.ts";

// 値(パスワード)は画面に出さない。一覧にもパスワードは来ない。ログにも値を出さない。
const root = document.getElementById("root")!;

async function send<T>(req: PopupRequest): Promise<T> {
  return (await chrome.runtime.sendMessage(req)) as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (typeof cls === "string") node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

function clear(): void {
  root.replaceChildren();
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
}

function errorText(code: string): string {
  switch (code) {
    case "wrong-master":
      return t("errWrongMaster");
    case "open-failed":
      return t("errOpenFailed");
    case "empty":
      return t("errEmpty");
    case "vault-unopenable":
      return t("errVaultUnopenable");
    case "unreachable":
      return t("errUnreachable");
    case "auth":
      return t("errAuth");
    case "not-configured":
      return t("errNotConfigured");
    default:
      return t("errUnknown");
  }
}

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
}

function renderNotConfigured(): void {
  clear();
  root.append(
    el("h1", {}, t("extName")),
    el("p", { class: "msg", id: "msg" }, t("notConfigured")),
    el("button", { class: "primary", onclick: openSettings, type: "button" }, t("settings")),
  );
}

/** ロック中、または「再読み込み」で、マスターパスワードを求める。 */
function renderMasterPrompt(opts: { reload: boolean; onCancel?: () => void }): void {
  clear();
  const input = el("input", {
    type: "password",
    id: "master",
    autocomplete: "off",
    spellcheck: false,
    placeholder: t("masterPassword"),
  });
  input.setAttribute("aria-label", t("masterPassword"));
  const msg = el("p", { class: "msg", id: "msg" });
  const submit = el("button", { class: "primary", type: "submit", id: "unlock" }, opts.reload ? t("reload") : t("unlock"));
  const form = el("form", {}, input, el("div", { class: "row" }, submit), msg);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const master = input.value;
    input.value = "";
    if (master === "") return;
    submit.disabled = true;
    msg.className = "msg note";
    msg.textContent = t("unlocking");
    void send<UnlockResponse>({ type: "unlock", master })
      .then((res) => {
        if (res && res.ok) {
          void refresh();
          return;
        }
        msg.className = "msg error";
        msg.textContent = errorText(res && !res.ok ? res.error : "unknown");
        submit.disabled = false;
        input.focus();
      })
      .catch(() => {
        msg.className = "msg error";
        msg.textContent = t("errUnknown");
        submit.disabled = false;
      });
  });
  const head: Node[] = [el("h1", {}, opts.reload ? t("reload") : t("locked"))];
  root.append(...head, form);
  const bar = el("div", { class: "row" });
  if (opts.onCancel) bar.append(el("button", { type: "button", onclick: opts.onCancel }, t("cancel")));
  bar.append(el("button", { type: "button", onclick: openSettings }, t("settings")));
  root.append(bar);
  input.focus();
}

function itemCard(item: ListedItem): HTMLElement {
  const card = el("div", { class: "item" });
  card.dataset.id = item.id;
  const result = el("div", { class: "result" });
  result.setAttribute("role", "status");
  const setResult = (text: string, cls = "") => {
    result.className = `result ${cls}`.trim();
    result.textContent = text;
  };
  const actions = el("div", { class: "actions" });
  const add = (action: string, label: string, onClick: () => void) => {
    const b = el("button", { type: "button" }, label);
    b.dataset.action = action;
    b.addEventListener("click", onClick);
    actions.append(b);
  };

  if (item.matches) {
    add("fill", t("fill"), () => {
      void send<FillResponse>({ type: "fill", id: item.id }).then((res) =>
        res && res.ok ? setResult(t("filled"), "ok") : setResult(t("fillFailed"), "warn"),
      );
    });
  }
  const copy = (field: "username" | "password") => () => {
    void send<OkResponse>({ type: "copy", id: item.id, field }).then((res) =>
      res && res.ok
        ? setResult(t("copied", String(CLIPBOARD_CLEAR_MS / 1000)))
        : setResult(t("copyFailed"), "warn"),
    );
  };
  add("copy-username", t("copyUser"), copy("username"));
  add("copy-password", t("copyPassword"), copy("password"));
  if (item.isLogin) {
    add("breach", t("breachCheck"), () => {
      setResult(t("breachChecking"));
      void send<BreachResponse>({ type: "breach", id: item.id }).then((res) => {
        if (!res) return setResult(t("breachError"), "warn");
        switch (res.status) {
          case "pwned":
            return setResult(t("breachPwned", String(res.count)), "warn");
          case "clean":
            return setResult(t("breachClean"), "ok");
          case "error":
            return setResult(t("breachError"), "warn");
          default:
            return setResult(t("breachError"), "warn");
        }
      });
    });
  }

  card.append(el("div", { class: "title" }, item.title || "(no title)"));
  const sub = [item.username, item.url].filter((s) => s !== "").join(" / ");
  if (sub !== "") card.append(el("div", { class: "sub" }, sub));
  card.append(actions, result);
  return card;
}

function matchesQuery(item: ListedItem, q: string): boolean {
  // 検索の対象はタイトル・ユーザー名・URL。値(パスワード)は検索しない。
  const needle = q.toLowerCase();
  return [item.title, item.username, item.url].some((s) => s.toLowerCase().includes(needle));
}

function renderUnlocked(state: StateResponse, list: ListResponse): void {
  clear();
  const toolbar = el(
    "div",
    { class: "toolbar" },
    el("button", { type: "button", id: "lock", onclick: () => void send({ type: "lock" }).then(refresh) }, t("lock")),
    el("button", { type: "button", id: "reload", onclick: () => renderMasterPrompt({ reload: true, onCancel: () => void refresh() }) }, t("reload")),
    el("span", { class: "grow" }),
    el("button", { type: "button", onclick: openSettings }, t("settings")),
  );
  root.append(toolbar);
  if (state.source === "cache") {
    root.append(el("p", { class: "msg note", id: "sync-note" }, t("cacheNote", formatTime(state.lastSync))));
  } else if (state.lastSync) {
    root.append(el("p", { class: "msg note", id: "sync-note" }, t("lastSync", formatTime(state.lastSync))));
  }

  const search = el("input", { type: "search", id: "search", placeholder: t("search"), autocomplete: "off" });
  search.setAttribute("aria-label", t("search"));
  const matchBox = el("div", { id: "matches" });
  const allBox = el("div", { id: "all" });
  root.append(matchBox, search, allBox);

  const matching = list.items.filter((i) => i.matches);
  if (matching.length > 0) {
    matchBox.append(el("h2", {}, t("forThisPage")));
    for (const i of matching) matchBox.append(itemCard(i));
  }

  const renderAll = () => {
    allBox.replaceChildren();
    const q = search.value.trim();
    const rest = list.items.filter((i) => !i.matches && (q === "" || matchesQuery(i, q)));
    allBox.append(el("h2", {}, t("allItems")));
    if (rest.length === 0) allBox.append(el("p", { class: "msg note" }, t("noItems")));
    for (const i of rest.slice(0, 100)) allBox.append(itemCard(i));
  };
  search.addEventListener("input", renderAll);
  renderAll();
}

async function refresh(): Promise<void> {
  const state = await send<StateResponse | null>({ type: "state" });
  if (!state || !state.configured) return renderNotConfigured();
  if (!state.unlocked) return renderMasterPrompt({ reload: false });
  const list = await send<ListResponse | null>({ type: "list" });
  if (!list || !list.unlocked) return renderMasterPrompt({ reload: false });
  renderUnlocked(state, list);
}

void refresh();
