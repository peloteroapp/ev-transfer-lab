/* Shared helpers: formatting, colors, tooltip, fitting, video lookup. */
/* global d3 */

export const fmt = {
  f1: d3.format(".1f"),
  f0: d3.format(".0f"),
  f2: d3.format(".2f"),
  s1: (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + d3.format(".1f")(Math.abs(v)),
  s2: (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + d3.format(".2f")(Math.abs(v)),
  pct: d3.format(".0%"),
  pct1: d3.format(".1%"),
  int: d3.format(","),
  ord: (n) => {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  },
};

/** Percentile as an ordinal, capped at 99th (100th reads as an error). */
export const pctOrd = (p01) => fmt.ord(Math.max(1, Math.min(99, Math.round(p01 * 100))));

export const nil = (v) => v === null || v === undefined || Number.isNaN(v);
export const show = (v, f = fmt.f1, dash = "–") => (nil(v) ? dash : f(v));

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Diverging blue (above expected) / orange (below) with a gray midpoint. */
export function divergingScale(limit = 3) {
  const neg = cssVar("--neg"), mid = cssVar("--mid"), pos = cssVar("--pos");
  const lo = d3.interpolateLab(neg, mid), hi = d3.interpolateLab(mid, pos);
  return d3.scaleDiverging([-limit, 0, limit], (t) => (t < 0.5 ? lo(t * 2) : hi((t - 0.5) * 2))).clamp(true);
}

/** Pelotero rating wash: pale green at low percentiles to full acid at elite. */
export function ratingWash(p) {
  const t = Math.max(0, Math.min(1, p));
  return t < 0.7 ? d3.interpolateLab("#eef1e4", "#d6ef67")(t / 0.7) : d3.interpolateLab("#d6ef67", "#a9c934")((t - 0.7) / 0.3);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ---------- tooltip (DOM-built, never innerHTML) */
const tip = () => document.getElementById("tooltip");

export function showTip(event, title, rows = [], hint) {
  const t = tip();
  t.replaceChildren(
    el("div", { class: "tt-title" }, title),
    ...rows.map(([k, v]) => el("div", { class: "tt-row" }, el("span", { class: "tt-k" }, k), el("b", {}, v))),
    hint ? el("div", { class: "tt-hint" }, hint) : null,
  );
  t.hidden = false;
  const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
export function hideTip() { tip().hidden = true; }

/* ---------- fitting */
/** Weighted least-squares quadratic y = a + b x + c x^2. Returns predict(x). */
export function quadFit(xs, ys, ws) {
  const S = Array.from({ length: 3 }, () => [0, 0, 0]);
  const T = [0, 0, 0];
  const mx = d3.mean(xs);
  xs.forEach((x0, i) => {
    const x = x0 - mx, w = ws ? ws[i] : 1, v = [1, x, x * x];
    for (let a = 0; a < 3; a++) {
      T[a] += w * v[a] * ys[i];
      for (let b = 0; b < 3; b++) S[a][b] += w * v[a] * v[b];
    }
  });
  const beta = solve3(S, T);
  return (x0) => { const x = x0 - mx; return beta[0] + beta[1] * x + beta[2] * x * x; };
}
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[3] / r[i]);
}

/* ---------- video: Savant clip for one pitch via the MLB Stats API play id */
const pbp = new Map();
async function playIdFor(pk, ab, pn) {
  if (!pbp.has(pk)) {
    pbp.set(pk, fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/playByPlay`).then((r) => {
      if (!r.ok) throw new Error(`play-by-play ${r.status}`);
      return r.json();
    }));
  }
  const game = await pbp.get(pk);
  const play = game.allPlays.find((p) => p.about.atBatIndex === ab - 1);
  const pitch = play && play.playEvents.find((e) => e.isPitch && e.pitchNumber === pn);
  return pitch ? pitch.playId : null;
}

export async function openVideo(btn, swing) {
  // Open the tab synchronously (popup blockers), then point it at the clip.
  const win = window.open("", "_blank");
  if (win) win.opener = null;
  if (btn) btn.disabled = true;
  let url = `https://baseballsavant.mlb.com/gamefeed?gamePk=${swing.pk}`;
  try {
    const id = await playIdFor(swing.pk, swing.ab, swing.pn);
    if (id) url = `https://baseballsavant.mlb.com/sporty-videos?playId=${id}`;
  } catch (e) {
    console.warn("video lookup failed, falling back to game feed", e);
  }
  if (win) win.location.href = url;
  else window.location.href = url;
  if (btn) btn.disabled = false;
}

export function watchButton(swing, label = "Watch") {
  return el("button", {
    class: "watch", type: "button", title: "Open this swing's video on Baseball Savant",
    onclick: (e) => { e.stopPropagation(); openVideo(e.currentTarget, swing); },
  }, label);
}

export const PITCH_NAMES = {
  FF: "4-seam", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper", CU: "Curve",
  KC: "Knuckle curve", SV: "Slurve", CH: "Changeup", FS: "Splitter", FO: "Forkball",
  KN: "Knuckleball", EP: "Eephus", SC: "Screwball", CS: "Slow curve", FA: "Fastball",
};
