/**
 * Minimal, dependency-free client for the MFP public market-data WebSocket.
 * Works in browsers and Node 22+ (global WebSocket).
 *
 *  - one multiplexed socket; subscriptions are re-established after reconnect
 *  - exponential backoff with full jitter, capped; resets after a healthy connection
 *  - `draining` → connect a replacement, resubscribe, then close the old socket
 *  - one-shot requests (candles.history, ping) with timeouts and a concurrency cap
 *    (the server allows at most 4 in-flight history requests per connection)
 *  - never sends any credential: market data is public
 */

export const MARKET_DATA_URL = "wss://api-stream.myfundedperpetuals.com/v1/market-data";

export type Channel = "ticks" | "books" | "trades" | "candles" | "marketStats" | "status";

export interface SubSpec {
  channel: Channel;
  payload: Record<string, unknown>;
}

export interface SubHandlers {
  onEvents(events: any[], replay: boolean): void;
  /** called each time the subscription is accepted (first time and after every reconnect) */
  onSubscribed?(info: { snapshotBoundary: boolean }): void;
  onSnapshotEnd?(): void;
  onError?(err: unknown): void;
}

export type ConnState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface StreamStatus {
  state: ConnState;
  attempt: number;
  /** last measured application ping RTT, ms */
  rttMs: number | null;
  /** server clock minus local clock (ms), from ping */
  clockSkewMs: number | null;
  lastFrameAt: number;
  connectedAt: number | null;
  /** last disconnect time (used for gap backfill) */
  lastDisconnectAt: number | null;
  message?: string;
}

interface ActiveSub {
  key: number;
  spec: SubSpec;
  handlers: SubHandlers;
  /** wire id on the current socket */
  wireId: number | null;
  sub: string | null;
  inReplay: boolean;
}

interface PendingReq {
  id: number;
  method: string;
  payload?: unknown;
  resolve(v: any): void;
  reject(e: any): void;
  timer: ReturnType<typeof setTimeout> | null;
  isHistory: boolean;
  sent: boolean;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly detail: any,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type Socket = WebSocket;

export interface StreamOptions {
  url?: string;
  maxHistoryInFlight?: number;
  requestTimeoutMs?: number;
  pingEveryMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** consider the connection dead if no frame for this long */
  staleAfterMs?: number;
  log?: (...a: unknown[]) => void;
}

export class MarketStream {
  readonly url: string;
  private ws: Socket | null = null;
  private oldWs: Socket | null = null;
  private nextId = 1;
  private subs = new Map<number, ActiveSub>();
  private bySub = new Map<string, Set<ActiveSub>>();
  private byWireId = new Map<number, ActiveSub>();
  private reqs = new Map<number, PendingReq>();
  private queue: PendingReq[] = [];
  private subKey = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private listeners = new Set<(s: StreamStatus) => void>();
  private opts: Required<Omit<StreamOptions, "url" | "log">>;
  private log: (...a: unknown[]) => void;
  status: StreamStatus = {
    state: "idle",
    attempt: 0,
    rttMs: null,
    clockSkewMs: null,
    lastFrameAt: 0,
    connectedAt: null,
    lastDisconnectAt: null,
  };

  constructor(opts: StreamOptions = {}) {
    this.url = opts.url ?? MARKET_DATA_URL;
    this.opts = {
      maxHistoryInFlight: opts.maxHistoryInFlight ?? 2,
      requestTimeoutMs: opts.requestTimeoutMs ?? 25_000,
      pingEveryMs: opts.pingEveryMs ?? 15_000,
      backoffBaseMs: opts.backoffBaseMs ?? 500,
      backoffMaxMs: opts.backoffMaxMs ?? 30_000,
      staleAfterMs: opts.staleAfterMs ?? 45_000,
    };
    this.log = opts.log ?? (() => {});
  }

  onStatus(fn: (s: StreamStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private setStatus(p: Partial<StreamStatus>) {
    this.status = { ...this.status, ...p };
    for (const fn of this.listeners) fn(this.status);
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws) return;
    this.open(false);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "client closing");
    } catch {
      /* ignore */
    }
    for (const r of this.reqs.values()) this.failReq(r, new RequestError("stream closed", null, false));
    this.reqs.clear();
    this.queue.length = 0;
    this.setStatus({ state: "closed" });
  }

  private open(replacement: boolean) {
    this.setStatus({ state: replacement ? this.status.state : this.status.attempt > 0 ? "reconnecting" : "connecting" });
    let ws: Socket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect(String(e));
      return;
    }
    const prev = this.ws;
    if (replacement && prev) this.oldWs = prev;
    this.ws = ws;
    // connection-local state is cleared: ids and sub mappings are per socket
    this.bySub.clear();
    this.byWireId.clear();
    for (const s of this.subs.values()) {
      s.wireId = null;
      s.sub = null;
    }
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.setStatus({ state: "open", connectedAt: Date.now(), lastFrameAt: Date.now(), message: undefined });
      for (const s of this.subs.values()) this.sendSub(s);
      // re-issue requests that were waiting or lost with the previous socket
      for (const r of this.reqs.values()) r.sent = false;
      this.pump();
      this.startPing();
      if (this.oldWs) {
        const old = this.oldWs;
        this.oldWs = null;
        // give the new socket a moment to deliver its snapshots before closing the old one
        setTimeout(() => {
          try {
            old.close(1000, "replaced");
          } catch {
            /* ignore */
          }
        }, 3_000);
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      this.status.lastFrameAt = Date.now();
      let f: any;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (this.ws !== ws) {
        // old (draining) socket: still deliver events, ignore control frames
        if (f.op === "events") this.dispatchEvents(f, true);
        return;
      }
      this.onFrame(f);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      this.setStatus({ lastDisconnectAt: Date.now(), connectedAt: null });
      for (const r of this.reqs.values()) {
        if (r.timer) clearTimeout(r.timer);
        r.timer = null;
        r.sent = false;
      }
      if (!this.closedByUser) this.scheduleReconnect(`closed (${ev.code}${ev.reason ? " " + ev.reason : ""})`);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(msg: string) {
    if (this.closedByUser || this.reconnectTimer) return;
    const attempt = this.status.attempt + 1;
    const cap = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** Math.min(attempt, 10));
    const delay = Math.round(cap / 2 + Math.random() * (cap / 2)); // "equal jitter"
    this.setStatus({ state: "reconnecting", attempt, message: `${msg}; retry in ${(delay / 1000).toFixed(1)}s` });
    this.log("reconnect in", delay, msg);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(false);
    }, delay);
  }

  private startPing() {
    this.stopPing();
    const ping = () => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (Date.now() - this.status.lastFrameAt > this.opts.staleAfterMs) {
        this.log("stale connection, reconnecting");
        try {
          this.ws.close(4000, "stale");
        } catch {
          /* ignore */
        }
        return;
      }
      const t0 = performance.now();
      const local = Date.now();
      this.request("ping", undefined, 10_000)
        .then((serverMs: number) => {
          const rtt = performance.now() - t0;
          this.setStatus({ rttMs: Math.round(rtt), clockSkewMs: typeof serverMs === "number" ? Math.round(serverMs - (local + rtt / 2)) : null, attempt: 0 });
        })
        .catch(() => {});
    };
    ping();
    this.pingTimer = setInterval(ping, this.opts.pingEveryMs);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(obj: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  private allocId(): number {
    // ids must be unique among active subs/requests on a connection
    for (;;) {
      const id = this.nextId++;
      if (this.nextId > 2 ** 31) this.nextId = 1;
      if (!this.byWireId.has(id) && !this.reqs.has(id)) return id;
    }
  }

  /** Subscribe; returns an unsubscribe function. Re-established automatically after reconnects. */
  subscribe(spec: SubSpec, handlers: SubHandlers): () => void {
    const s: ActiveSub = { key: this.subKey++, spec, handlers, wireId: null, sub: null, inReplay: true };
    this.subs.set(s.key, s);
    this.sendSub(s);
    return () => {
      this.subs.delete(s.key);
      if (s.wireId !== null) {
        this.send({ op: "unsub", id: s.wireId });
        this.byWireId.delete(s.wireId);
      }
      if (s.sub) this.bySub.get(s.sub)?.delete(s);
    };
  }

  private sendSub(s: ActiveSub) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const id = this.allocId();
    s.wireId = id;
    s.inReplay = true;
    this.byWireId.set(id, s);
    this.send({ op: "sub", id, channel: s.spec.channel, payload: s.spec.payload });
  }

  request<T = any>(method: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const r: PendingReq = {
        id: 0,
        method,
        payload,
        resolve,
        reject,
        timer: null,
        isHistory: method === "candles.history",
        sent: false,
      };
      (r as any).timeoutMs = timeoutMs ?? this.opts.requestTimeoutMs;
      this.queue.push(r);
      this.pump();
    });
  }

  private pump() {
    if (!this.ws || this.ws.readyState !== 1) return;
    // resend requests orphaned by a reconnect
    for (const r of [...this.reqs.values()]) {
      if (!r.sent) {
        this.reqs.delete(r.id);
        this.queue.unshift(r);
      }
    }
    let historyInFlight = [...this.reqs.values()].filter((r) => r.isHistory).length;
    const rest: PendingReq[] = [];
    while (this.queue.length) {
      const r = this.queue.shift()!;
      if (r.isHistory && historyInFlight >= this.opts.maxHistoryInFlight) {
        rest.push(r);
        continue;
      }
      r.id = this.allocId();
      const msg: any = { op: "req", id: r.id, method: r.method };
      if (r.payload !== undefined) msg.payload = r.payload;
      if (!this.send(msg)) {
        rest.push(r);
        continue;
      }
      r.sent = true;
      this.reqs.set(r.id, r);
      if (r.isHistory) historyInFlight++;
      r.timer = setTimeout(() => {
        this.reqs.delete(r.id);
        this.send({ op: "unsub", id: r.id });
        r.reject(new RequestError(`${r.method} timed out`, null, true));
        this.pump();
      }, (r as any).timeoutMs);
    }
    this.queue.push(...rest);
  }

  private failReq(r: PendingReq, e: unknown) {
    if (r.timer) clearTimeout(r.timer);
    r.reject(e);
  }

  private onFrame(f: any) {
    switch (f.op) {
      case "sub_ok": {
        const s = this.byWireId.get(f.id);
        if (!s) return;
        s.sub = f.sub;
        let set = this.bySub.get(f.sub);
        if (!set) this.bySub.set(f.sub, (set = new Set()));
        set.add(s);
        s.inReplay = !!f.snapshotBoundary;
        s.handlers.onSubscribed?.({ snapshotBoundary: !!f.snapshotBoundary });
        return;
      }
      case "events":
        this.dispatchEvents(f, false);
        return;
      case "snapshot_end": {
        const s = this.byWireId.get(f.id);
        if (s) {
          s.inReplay = false;
          s.handlers.onSnapshotEnd?.();
        }
        return;
      }
      case "sub_err": {
        const s = this.byWireId.get(f.id);
        if (s) {
          this.byWireId.delete(f.id);
          s.wireId = null;
          s.handlers.onError?.(f.error);
        }
        return;
      }
      case "end": {
        const s = this.byWireId.get(f.id);
        if (s && this.subs.has(s.key)) {
          this.byWireId.delete(f.id);
          if (s.sub) this.bySub.get(s.sub)?.delete(s);
          setTimeout(() => this.subs.has(s.key) && this.sendSub(s), 1000 + Math.random() * 1000);
        }
        return;
      }
      case "draining":
        this.log("server draining; opening replacement");
        this.open(true);
        return;
      case "res":
      case "err": {
        const r = this.reqs.get(f.id);
        if (!r) return;
        this.reqs.delete(f.id);
        if (r.timer) clearTimeout(r.timer);
        if (f.op === "res") r.resolve(f.result);
        else {
          const e = f.error ?? {};
          const msg = String(e.message ?? e.reason ?? e._tag ?? "request failed");
          const retryable = e.source === "transport" || /too many|capacity|in-flight/i.test(msg);
          r.reject(new RequestError(msg, e, retryable));
        }
        this.pump();
        return;
      }
      default:
        return; // forward compatible
    }
  }

  private dispatchEvents(f: any, fromOld: boolean) {
    const set = this.bySub.get(f.sub);
    if (!set || !Array.isArray(f.events)) return;
    for (const s of set) s.handlers.onEvents(f.events, s.inReplay || fromOld);
  }
}

/** Retry a request with exponential backoff when the error is retryable. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof RequestError) || !e.retryable) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i * (0.5 + Math.random() / 2)));
    }
  }
  throw last;
}
