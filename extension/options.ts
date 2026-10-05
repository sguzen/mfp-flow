/**
 * Options page. Saves the key into the background worker's storage and runs the
 * two checks worth having: that this extension can read the REST API at all
 * (the CORS bypass), and that the saved key resolves to accounts.
 *
 * The key is write-only from here: once saved, nothing reads it back out.
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Reply<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

function send<T>(msg: unknown): Promise<Reply<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<Reply<T>>;
}

function say(el: HTMLElement, text: string, tone: "" | "ok" | "bad" = "") {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

const keyState = $("keyState");
const probeState = $("probeState");
const out = $<HTMLPreElement>("out");

async function refreshKeyState() {
  const r = await send<{ present: boolean; env: string | null }>({ type: "keyStatus" });
  if (!r.ok) return say(keyState, r.error, "bad");
  if (!r.data.present) return say(keyState, "No key saved. The panel will still chart the market; account lines need a key.");
  say(keyState, `Key saved — ${r.data.env === "sandbox" ? "Sandbox (test key)" : "LIVE account key"}.`, r.data.env === "sandbox" ? "ok" : "");
}

$("save").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("key");
  const key = input.value.trim();
  if (!key) return say(keyState, "Paste a key first.", "bad");
  const r = await send<{ env: string }>({ type: "setKey", key });
  input.value = "";
  if (!r.ok) return say(keyState, r.error, "bad");
  await refreshKeyState();
});

$("forget").addEventListener("click", async () => {
  await send({ type: "clearKey" });
  out.hidden = true;
  say(probeState, "");
  await refreshKeyState();
});

$("probe").addEventListener("click", async () => {
  say(probeState, "Checking…");
  const r = await send<{ ok: boolean; count?: number; detail: string }>({ type: "corsProbe" });
  if (!r.ok) return say(probeState, r.error, "bad");
  if (!r.data.ok) return say(probeState, `Could not reach the REST API: ${r.data.detail}`, "bad");
  say(probeState, `REST API readable from the extension — ${r.data.count} markets. (A web page is blocked here by CORS; the extension's host permissions are what allow it.)`, "ok");
});

$("accounts").addEventListener("click", async () => {
  say(probeState, "Loading accounts…");
  const r = await send<{ accounts: Record<string, unknown>[] }>({ type: "getAccounts" });
  if (!r.ok) {
    out.hidden = true;
    return say(probeState, r.error, "bad");
  }
  const rows = r.data.accounts.map((a) => ({
    id: a.id ?? a.account_id,
    name: a.name ?? a.nickname ?? null,
    stage: a.stage ?? null,
    equity: a.equity ?? null,
  }));
  say(probeState, `${rows.length} account(s).`, rows.length ? "ok" : "bad");
  out.hidden = false;
  out.textContent = JSON.stringify(rows, null, 2);
});

void refreshKeyState();
