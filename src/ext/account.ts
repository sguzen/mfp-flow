/**
 * The panel's view of the account, over the background worker's message API.
 * The key never comes back across this boundary — only data.
 *
 * Everything here no-ops outside the extension, because the same bundle is the
 * public web app, where `chrome.runtime` does not exist.
 */
export interface AccountRisk {
  equity: number | null;
  daily_loss_floor: number | null;
  max_drawdown_floor: number | null;
  daily_loss_room: number | null;
  max_drawdown_room: number | null;
  marks_complete?: boolean;
}
export interface AccountSummary {
  id: string;
  name?: string;
  account_number?: string;
  stage?: string;
  status?: string;
  starting_balance?: number;
  balance?: number;
  risk?: AccountRisk;
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

interface ChromeRuntime {
  runtime?: { sendMessage(msg: unknown): Promise<unknown>; id?: string };
}

function runtime(): ChromeRuntime["runtime"] | null {
  const c = (globalThis as unknown as { chrome?: ChromeRuntime }).chrome;
  return c?.runtime?.id ? c.runtime : null;
}

export const inExtension = () => runtime() != null;

async function send<T>(msg: unknown): Promise<T> {
  const rt = runtime();
  if (!rt) throw new Error("not running as an extension page");
  const r = (await rt.sendMessage(msg)) as Reply<T>;
  if (!r || typeof r !== "object") throw new Error("no reply from the extension");
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export const keyStatus = () => send<{ present: boolean; env: "sandbox" | "live" | null }>({ type: "keyStatus" });
export const getAccounts = () => send<{ accounts: AccountSummary[] }>({ type: "getAccounts" });
export const getAccountState = (accountId: string) =>
  send<{
    account: AccountSummary;
    policy: { fee_exempt?: boolean } | null;
    positions: Record<string, unknown>[];
    orders: Record<string, unknown>[];
    fetchedAt: number;
  }>({ type: "getAccountState", accountId });

/**
 * Room as a share of the allowance, for the warning colour.
 *
 * The API gives the floor and the room but not the day's opening equity, so the
 * allowance is taken as the distance from the account's starting balance down
 * to the floor. That is exact for max drawdown and an approximation for the
 * daily floor once the account is in profit, so the figure is labelled as a
 * share of the allowance rather than presented as the platform's own number.
 */
export function allowanceShare(room: number | null, startingBalance: number | undefined, floor: number | null): number | null {
  if (room == null || startingBalance == null || floor == null) return null;
  const limit = startingBalance - floor;
  if (!(limit > 0)) return null;
  return Math.max(0, Math.min(1, room / limit));
}
