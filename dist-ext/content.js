"use strict";
(() => {
  // extension/content.ts
  var PANEL_ID = "mfp-flow-panel-root";
  var MIN_W = 320;
  var MAX_W = 900;
  var STORE_W = "mfp_flow_panel_width";
  function marketFromLocation() {
    const m = location.pathname.match(/^\/trade\/([^/]+)\/?$/);
    const sym = m ? decodeURIComponent(m[1]).trim().toUpperCase() : null;
    const tradfi = new URLSearchParams(location.search).get("asset")?.toLowerCase() === "tradfi";
    return { symbol: sym || null, tradfi };
  }
  function panelUrl() {
    const { symbol, tradfi } = marketFromLocation();
    const q = new URLSearchParams({ embed: "1" });
    if (symbol) q.set("sym", symbol);
    if (tradfi) q.set("tradfi", "1");
    return chrome.runtime.getURL(`panel.html#${q.toString()}`);
  }
  var root = null;
  var frame = null;
  function savedWidth() {
    try {
      return Number(localStorage.getItem(STORE_W) ?? 0);
    } catch {
      return 0;
    }
  }
  function build() {
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
      if (frame) frame.style.pointerEvents = "none";
      const move = (ev) => {
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
        }
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    frame = document.createElement("iframe");
    frame.src = panelUrl();
    frame.style.cssText = "border:0;flex:1 1 auto;height:100%;width:100%";
    frame.setAttribute("title", "mfp\xB7flow chart panel");
    el.append(grip, frame);
    return el;
  }
  function complain(msg) {
    const b = document.getElementById("mfp-flow-toggle");
    if (!b) return;
    b.textContent = msg;
    b.setAttribute("style", `${b.getAttribute("style") ?? ""};border-color:#e5484d;color:#e5484d`);
  }
  function openInTab() {
    window.open(panelUrl(), "_blank", "noopener,width=520,height=900");
  }
  var readyTimer = 0;
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
      clearTimeout(readyTimer);
      readyTimer = window.setTimeout(() => {
        if (!panelReady) {
          complain("mfp\xB7flow \u2014 open in tab");
          const b = document.getElementById("mfp-flow-toggle");
          b?.addEventListener("click", openInTab, { once: true });
        }
      }, 4e3);
    } catch (e) {
      complain("mfp\xB7flow \u2014 failed");
      console.error("[mfp-flow] could not open the panel:", e);
    }
  }
  var panelReady = false;
  window.addEventListener("message", (e) => {
    const d = e.data;
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
    b.textContent = "mfp\xB7flow";
    b.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483001;padding:8px 14px;border-radius:999px;border:1px solid #232c38;background:#141a21;color:#e6edf3;font:600 12px ui-sans-serif,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)";
    b.addEventListener("click", toggle);
    document.body.appendChild(b);
  }
  function notifyMarket() {
    if (!frame?.contentWindow) return;
    const { symbol, tradfi } = marketFromLocation();
    frame.contentWindow.postMessage({ source: "mfp-flow", type: "market", symbol, tradfi }, "*");
  }
  var lastUrl = location.href;
  var onNav = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    notifyMarket();
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function(...args) {
      const r = orig.apply(this, args);
      queueMicrotask(onNav);
      return r;
    };
  }
  window.addEventListener("popstate", onNav);
  addButton();
})();
