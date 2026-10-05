/**
 * Content script: adds a toggle to the MFP terminal that opens the mfp·flow
 * panel beside it, as an iframe of an extension page.
 *
 * It deliberately knows almost nothing. It reads the market from the URL (the
 * terminal puts it in the path) and forwards it; the panel owns the market list
 * and does the resolving. It reads no other page state, touches no page data,
 * and never sees the API key.
 */
const PANEL_ID = "mfp-flow-panel-root";
const MIN_W = 320;
const MAX_W = 900;
const STORE_W = "mfp_flow_panel_width";

function marketFromLocation(): { symbol: string | null; tradfi: boolean } {
  const m = location.pathname.match(/^\/trade\/([^/]+)\/?$/);
  const sym = m ? decodeURIComponent(m[1]).trim().toUpperCase() : null;
  const tradfi = new URLSearchParams(location.search).get("asset")?.toLowerCase() === "tradfi";
  return { symbol: sym || null, tradfi };
}

function panelUrl(): string {
  const { symbol, tradfi } = marketFromLocation();
  const q = new URLSearchParams({ embed: "1" });
  if (symbol) q.set("sym", symbol);
  if (tradfi) q.set("tradfi", "1");
  return chrome.runtime.getURL(`panel.html#${q.toString()}`);
}

let root: HTMLDivElement | null = null;
let frame: HTMLIFrameElement | null = null;

/** The host page's storage can be blocked or partitioned; a width is not worth failing over. */
function savedWidth(): number {
  try {
    return Number(localStorage.getItem(STORE_W) ?? 0);
  } catch {
    return 0;
  }
}

function build(): HTMLDivElement {
  const el = document.createElement("div");
  el.id = PANEL_ID;
  const width = Math.min(MAX_W, Math.max(MIN_W, savedWidth() || 460));
  el.style.cssText = `position:fixed;top:0;right:0;height:100vh;width:${width}px;z-index:2147483000;display:flex;background:#0b0e11;border-left:1px solid #232c38;box-shadow:-12px 0 32px rgba(0,0,0,.45)`;

  const grip = document.createElement("div");
  grip.title = "Drag to resize";
  grip.style.cssText = "width:6px;cursor:col-resize;background:transparent;flex:0 0 6px";
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    // the iframe would swallow the mouse while dragging over it
    if (frame) frame.style.pointerEvents = "none";
    const move = (ev: MouseEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)));
      el.style.width = `${w}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (frame) frame.style.pointerEvents = "";
      try {
        localStorage.setItem(STORE_W, String(Math.round(el.getBoundingClientRect().width)));
      } catch {
        /* storage blocked */
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  frame = document.createElement("iframe");
  frame.src = panelUrl();
  frame.style.cssText = "border:0;flex:1 1 auto;height:100%;width:100%";
  frame.setAttribute("title", "mfp·flow chart panel");

  el.append(grip, frame);
  return el;
}

/** Last-resort visible feedback: a silent failure is the worst outcome here. */
function complain(msg: string) {
  const b = document.getElementById("mfp-flow-toggle");
  if (!b) return;
  b.textContent = msg;
  b.setAttribute("style", `${b.getAttribute("style") ?? ""};border-color:#e5484d;color:#e5484d`);
}

function openInTab() {
  window.open(panelUrl(), "_blank", "noopener,width=520,height=900");
}

let readyTimer = 0;
function toggle() {
  try {
    if (root) {
      root.remove();
      root = null;
      frame = null;
      clearTimeout(readyTimer);
      return;
    }
    root = build();
    document.body.appendChild(root);
    // A site's frame-src policy can refuse a chrome-extension: iframe. The panel
    // posts "ready" once it loads; if that never arrives, say so and offer a tab.
    clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      if (!panelReady) {
        complain("mfp·flow — open in tab");
        const b = document.getElementById("mfp-flow-toggle");
        b?.addEventListener("click", openInTab, { once: true });
      }
    }, 4000);
  } catch (e) {
    complain("mfp·flow — failed");
    console.error("[mfp-flow] could not open the panel:", e);
  }
}

let panelReady = false;
window.addEventListener("message", (e) => {
  const d = e.data as { source?: string; type?: string } | null;
  if (d?.source === "mfp-flow" && d.type === "ready") {
    panelReady = true;
    clearTimeout(readyTimer);
  }
});

function addButton() {
  if (document.getElementById("mfp-flow-toggle")) return;
  const b = document.createElement("button");
  b.id = "mfp-flow-toggle";
  b.type = "button";
  b.textContent = "mfp·flow";
  b.style.cssText =
    "position:fixed;right:14px;bottom:14px;z-index:2147483001;padding:8px 14px;border-radius:999px;border:1px solid #232c38;background:#141a21;color:#e6edf3;font:600 12px ui-sans-serif,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)";
  b.addEventListener("click", toggle);
  document.body.appendChild(b);
}

/** Tell the panel when the terminal changes market without a page load. */
function notifyMarket() {
  if (!frame?.contentWindow) return;
  const { symbol, tradfi } = marketFromLocation();
  frame.contentWindow.postMessage({ source: "mfp-flow", type: "market", symbol, tradfi }, "*");
}

let lastUrl = location.href;
const onNav = () => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  notifyMarket();
};
// the terminal is a single-page app, so patch the history methods it navigates with
for (const m of ["pushState", "replaceState"] as const) {
  const orig = history[m];
  history[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
    const r = orig.apply(this, args);
    queueMicrotask(onNav);
    return r;
  };
}
window.addEventListener("popstate", onNav);

addButton();
