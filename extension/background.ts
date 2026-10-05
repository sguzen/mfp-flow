/**
 * Background service worker: the only place the API key exists.
 *
 * Content scripts and the panel never see it — they ask for data and get data.
 * The key lives in chrome.storage.local (never `sync`, which would replicate it
 * to every signed-in browser). This worker only ever reads: there is no order
 * placement, modification or cancellation anywhere in this extension.
 *
 * Host is chosen by key prefix, as the API requires: fp_test_ keys are served
 * at sandbox.myfundedperpetuals.com and fp_live_ keys at developers., and a key
 * presented to the wrong host is rejected with 401.
 */
const HOSTS = {
  sandbox: "https://sandbox.myfundedperpetuals.com",
  live: "https://developers.myfundedperpetuals.com",
} as const;

export type Env = keyof typeof HOSTS;
const KEY_NAME = "mfp_api_key";
/** one account refresh per this many ms, per account */
const REFRESH_MS = 5_000;

const envOf = (key: string): Env => (key.startsWith("fp_test_") ? "sandbox" : "live");

async function readKey(): Promise<string | null> {
  const got = await chrome.storage.local.get(KEY_NAME);
  const k = got[KEY_NAME];
  return typeof k === "string" && k.length > 0 ? k : null;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/** Earliest time we may call again, set by a 429. */
let rateLimitedUntil = 0;

async function api<T>(path: string): Promise<T> {
  const key = await readKey();
  if (!key) throw new ApiError("No API key saved. Open the extension's options page.", 0);
  const wait = rateLimitedUntil - Date.now();
  if (wait > 0) throw new ApiError(`Rate limited; retrying in ${Math.ceil(wait / 1000)}s.`, 429, Math.ceil(wait / 1000));

  const res = await fetch(`${HOSTS[envOf(key)]}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    credentials: "omit",
  });
  if (res.status === 429) {
    const after = Number(res.headers.get("Retry-After") ?? 5);
    rateLimitedUntil = Date.now() + after * 1000;
    throw new ApiError(`Rate limited by the API; retry in ${after}s.`, 429, after);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Prove this worker can read the REST API at all. The same call from a web page
 * is blocked by CORS (the API only allows MFP's docs origin), so a success here
 * is the host_permissions bypass working. Needs no key.
 */
async function corsProbe(): Promise<{ ok: boolean; count?: number; detail: string }> {
  try {
    const res = await fetch(`${HOSTS.live}/v1/markets`, { credentials: "omit" });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: unknown[] };
    return { ok: true, count: body.data?.length ?? 0, detail: "Read the REST API from the service worker." };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

interface AccountState {
  account: unknown;
  policy: unknown;
  positions: unknown[];
  orders: unknown[];
  fetchedAt: number;
}
const inFlight = new Map<string, { at: number; p: Promise<AccountState> }>();

/**
 * Account, its trading policy, open positions and working orders.
 * `status=working` is the API's only accepted order filter — it returns the
 * complete pending-and-resting set.
 */
async function accountState(accountId: string): Promise<AccountState> {
  const hit = inFlight.get(accountId);
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.p;
  const p = (async (): Promise<AccountState> => {
    const q = `account_id=${encodeURIComponent(accountId)}`;
    const [account, policy, positions, orders] = await Promise.all([
      api<unknown>(`/v1/accounts/${encodeURIComponent(accountId)}`),
      api<unknown>(`/v1/accounts/${encodeURIComponent(accountId)}/trading-policy`).catch(() => null),
      api<{ data?: unknown[] }>(`/v1/positions?${q}&status=open`).then((r) => r.data ?? []),
      api<{ data?: unknown[] }>(`/v1/orders?${q}&status=working&limit=100`).then((r) => r.data ?? []),
    ]);
    return { account, policy, positions, orders, fetchedAt: Date.now() };
  })();
  inFlight.set(accountId, { at: Date.now(), p });
  p.catch(() => inFlight.delete(accountId));
  return p;
}

type Msg =
  | { type: "keyStatus" }
  | { type: "setKey"; key: string }
  | { type: "clearKey" }
  | { type: "corsProbe" }
  | { type: "getAccounts" }
  | { type: "getAccountState"; accountId: string };

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "keyStatus": {
        const key = await readKey();
        // never return the key itself, only whether there is one and where it points
        return { present: !!key, env: key ? envOf(key) : null };
      }
      case "setKey": {
        const key = msg.key.trim();
        if (!/^fp_(test|live)_/.test(key)) throw new Error("That does not look like an MFP API key (expected fp_test_… or fp_live_…).");
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
        return api<{ data?: unknown[] }>("/v1/accounts").then((r) => ({ accounts: r.data ?? [] }));
      case "getAccountState":
        return accountState(msg.accountId);
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e: Error) => sendResponse({ ok: false, error: e.message, status: (e as ApiError).status }));
  return true; // keep the message channel open for the async reply
});
