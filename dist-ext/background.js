// extension/background.ts
var HOSTS = {
  sandbox: "https://sandbox.myfundedperpetuals.com",
  live: "https://developers.myfundedperpetuals.com"
};
var KEY_NAME = "mfp_api_key";
var REFRESH_MS = 5e3;
var envOf = (key) => key.startsWith("fp_test_") ? "sandbox" : "live";
async function readKey() {
  const got = await chrome.storage.local.get(KEY_NAME);
  const k = got[KEY_NAME];
  return typeof k === "string" && k.length > 0 ? k : null;
}
var ApiError = class extends Error {
  constructor(message, status, retryAfterS) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
  status;
  retryAfterS;
};
var rateLimitedUntil = 0;
async function api(path) {
  const key = await readKey();
  if (!key) throw new ApiError("No API key saved. Open the extension's options page.", 0);
  const wait = rateLimitedUntil - Date.now();
  if (wait > 0) throw new ApiError(`Rate limited; retrying in ${Math.ceil(wait / 1e3)}s.`, 429, Math.ceil(wait / 1e3));
  const res = await fetch(`${HOSTS[envOf(key)]}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    credentials: "omit"
  });
  if (res.status === 429) {
    const after = Number(res.headers.get("Retry-After") ?? 5);
    rateLimitedUntil = Date.now() + after * 1e3;
    throw new ApiError(`Rate limited by the API; retry in ${after}s.`, 429, after);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error?.message) detail = body.error.message;
    } catch {
    }
    throw new ApiError(detail, res.status);
  }
  return await res.json();
}
async function apiData(path) {
  const body = await api(path);
  return body?.data ?? null;
}
async function corsProbe() {
  try {
    const res = await fetch(`${HOSTS.live}/v1/markets`, { credentials: "omit" });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, count: body.data?.length ?? 0, detail: "Read the REST API from the service worker." };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
var inFlight = /* @__PURE__ */ new Map();
async function accountState(accountId) {
  const hit = inFlight.get(accountId);
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.p;
  const p = (async () => {
    const q = `account_id=${encodeURIComponent(accountId)}`;
    const [account, policy, positions, orders] = await Promise.all([
      apiData(`/v1/accounts/${encodeURIComponent(accountId)}`),
      apiData(`/v1/accounts/${encodeURIComponent(accountId)}/trading-policy`).catch(() => null),
      apiData(`/v1/positions?${q}&status=open`).then((d) => d ?? []),
      apiData(`/v1/orders?${q}&status=working&limit=100`).then((d) => d ?? [])
    ]);
    return { account, policy, positions, orders, fetchedAt: Date.now() };
  })();
  inFlight.set(accountId, { at: Date.now(), p });
  p.catch(() => inFlight.delete(accountId));
  return p;
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "keyStatus": {
        const key = await readKey();
        return { present: !!key, env: key ? envOf(key) : null };
      }
      case "setKey": {
        const key = msg.key.trim();
        if (!/^fp_(test|live)_/.test(key)) throw new Error("That does not look like an MFP API key (expected fp_test_\u2026 or fp_live_\u2026).");
        await chrome.storage.local.set({ [KEY_NAME]: key });
        return { present: true, env: envOf(key) };
      }
      case "clearKey":
        await chrome.storage.local.remove(KEY_NAME);
        inFlight.clear();
        return { present: false, env: null };
      case "corsProbe":
        return corsProbe();
      case "getAccounts":
        return apiData("/v1/accounts").then((d) => ({ accounts: d ?? [] }));
      case "getAccountState":
        return accountState(msg.accountId);
    }
  })().then((data) => sendResponse({ ok: true, data })).catch((e) => sendResponse({ ok: false, error: e.message, status: e.status }));
  return true;
});
