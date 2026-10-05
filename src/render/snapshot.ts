/**
 * Snapshot export: the chart (including the right-hand profile, which lives on
 * the same canvas) plus a baked footer strip naming what you are looking at, so
 * a pasted image is still attributable without its caption.
 */
import type { TimeZoneMode } from "./format";

export interface CaptionInput {
  market: string;
  view: "footprint" | "profiles" | "tpo";
  tfMin: number;
  sessionDate: string;
  at: Date;
}

/** Left and right halves of the footer. Pure, so the wording is testable. */
export function snapshotCaption(i: CaptionInput): { left: string; right: string } {
  const view = i.view === "tpo" ? "TPO 30m" : i.view === "profiles" ? `Profiles ${i.tfMin}m` : `Footprint ${i.tfMin}m`;
  const stamp = `${i.at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return {
    left: `${i.market} · ${view} · session ${i.sessionDate}`,
    right: `${stamp} · mfp·flow · data: MyFundedPerps`,
  };
}

/** A filename that sorts by time and survives every filesystem. */
export function snapshotFilename(market: string, view: string, at: Date): string {
  const slug = market.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return `mfp-flow_${slug}_${view}_${at.toISOString().slice(0, 16).replace(/[-:T]/g, "")}.png`;
}

export interface ComposeOpts {
  chart: HTMLCanvasElement;
  caption: { left: string; right: string };
  scale: number;
  bg: string;
  fg: string;
  dim: string;
  border: string;
}

/** Draw the chart plus the footer strip into a new canvas. */
export function composeSnapshot(o: ComposeOpts): HTMLCanvasElement {
  const padY = 26;
  const out = document.createElement("canvas");
  out.width = o.chart.width;
  out.height = o.chart.height + Math.round(padY * o.scale);
  const ctx = out.getContext("2d");
  if (!ctx) return o.chart;
  ctx.fillStyle = o.bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(o.chart, 0, 0);

  ctx.setTransform(o.scale, 0, 0, o.scale, 0, 0);
  const w = out.width / o.scale;
  const y = o.chart.height / o.scale;
  ctx.strokeStyle = o.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(w, y + 0.5);
  ctx.stroke();

  const mid = y + padY / 2;
  ctx.textBaseline = "middle";
  ctx.font = `600 11px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = o.fg;
  ctx.textAlign = "left";
  ctx.fillText(o.caption.left, 10, mid);
  ctx.font = `11px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = o.dim;
  ctx.textAlign = "right";
  ctx.fillText(o.caption.right, w - 10, mid);
  return out;
}

export type { TimeZoneMode };
