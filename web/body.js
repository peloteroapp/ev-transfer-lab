/* Body size section: height, weight and height/weight ratio vs bat speed and exit velo. */
/* global d3 */
import { fmt, show, nil, el, cssVar, divergingScale, showTip, hideTip, linFit, pearson, feetInches } from "./lib.js";
import { frame, axes, nearestLayer, setKids } from "./charts.js";

export const BODY_X = {
  ht: { label: "Height", unit: "in", axis: "Listed height (in)", f: feetInches, per: "inch", step: 1, jitter: 0.35 },
  wt: { label: "Weight", unit: "lb", axis: "Listed weight (lb)", f: (v) => `${fmt.f0(v)} lb`, per: "10 lb", step: 10, jitter: 1.5 },
  htwt: { label: "Height ÷ weight", unit: "in/lb", axis: "Height ÷ weight (in per lb; lower = more mass for the frame)", f: (v) => d3.format(".3f")(v), per: "0.01 in/lb", step: 0.01, jitter: 0 },
};
export const BODY_Y = {
  bs: { label: "Bat speed", lc: "bat speed", axis: "Avg bat speed (mph)", f: fmt.f1, unit: "mph" },
  ev: { label: "Avg exit velo", lc: "avg exit velo", axis: "Avg exit velo (mph)", f: fmt.f1, unit: "mph" },
  ev90: { label: "EV90", lc: "EV90", axis: "EV90, 90th pct exit velo (mph)", f: fmt.f1, unit: "mph" },
  evoe: { label: "EV over expected", lc: "EV over expected", axis: "EV over expected (mph)", f: fmt.s1, unit: "mph" },
};

// Flag at the value that displays as 2.0 SD, so the table and chart agree with what's printed.
const isOutlier = (z) => Math.abs(z) >= 1.95;

// Stable per-hitter jitter so integer heights / 5-lb weights don't stack into columns.
const jitterOf = (id) => ((Math.sin(id * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5;

function textOn(fill) {
  const c = d3.rgb(fill);
  const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return lum > 0.55 ? "#152237" : "#ffffff";
}

/** Correlation matrix: rows = body metrics, cols = outcomes. Click a cell to plot that pair. */
function matrix(container, rows, state, onPick) {
  const scale = divergingScale(0.6);
  const cells = {};
  for (const x of Object.keys(BODY_X)) {
    for (const y of Object.keys(BODY_Y)) {
      const pts = rows.filter((h) => !nil(h[x]) && !nil(h[y]));
      cells[`${x}|${y}`] = pearson(pts.map((h) => h[x]), pts.map((h) => h[y]));
    }
  }
  const table = el("table", { class: "corr-matrix" },
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, ""),
      Object.values(BODY_Y).map((m) => el("th", { scope: "col" }, m.label)))),
    el("tbody", {}, Object.entries(BODY_X).map(([x, xm]) => el("tr", {},
      el("th", { scope: "row" }, xm.label),
      Object.keys(BODY_Y).map((y) => {
        const c = cells[`${x}|${y}`];
        const bg = Number.isNaN(c.r) ? "transparent" : scale(c.r);
        const on = state.bodyX === x && state.bodyY === y;
        return el("td", {},
          el("button", {
            type: "button", class: `corr-cell${on ? " on" : ""}`, "aria-pressed": String(on),
            "aria-label": `${xm.label} vs ${BODY_Y[y].label}: r ${fmt.f2(c.r)}, ${c.n} hitters`,
            style: `background:${bg};color:${textOn(bg)}`,
            onclick: () => onPick(x, y),
            onpointermove: (e) => showTip(e, `${xm.label} vs ${BODY_Y[y].label}`, [
              ["r", d3.format("+.2f")(c.r)], ["95% range", `${d3.format("+.2f")(c.lo)} to ${d3.format("+.2f")(c.hi)}`],
              ["Share of variance", fmt.pct(c.r ** 2)], ["Hitters", fmt.int(c.n)],
            ], "Click to plot this pair"),
            onpointerleave: hideTip,
          }, Number.isNaN(c.r) ? "–" : d3.format("+.2f")(c.r)));
      }))))
  );
  container.replaceChildren(el("div", { class: "table-wrap" }, table));
  return cells;
}

/** Plain-language read of the matrix for the current filters. */
function takeaway(cells) {
  const r = (x, y) => cells[`${x}|${y}`].r;
  const best = (y) => d3.greatest(Object.keys(BODY_X), (x) => Math.abs(r(x, y)));
  const bsX = best("bs"), evoeX = best("evoe");
  if (Number.isNaN(r(bsX, "bs"))) return "Not enough hitters in this filter to correlate.";
  const ratio = r("htwt", "bs");
  const ht = r("ht", "bs"), wt = r("wt", "bs");
  const lead = Math.abs(ht - wt) < 0.03
    ? `Height and weight track bat speed about equally (r ${fmt.f2(ht)} and ${fmt.f2(wt)}; each explains about ${fmt.pct(Math.max(ht, wt) ** 2)} of the spread).`
    : `${BODY_X[bsX].label} tracks bat speed most closely (r ${fmt.f2(r(bsX, "bs"))}, explaining ${fmt.pct(r(bsX, "bs") ** 2)} of the spread).`;
  return [
    lead,
    ` The height ÷ weight ratio runs ${ratio < 0 ? "the other way" : "the same way"} (r ${fmt.f2(ratio)}): ${ratio < 0 ? "more mass per inch goes with more bat speed." : "leaner frames go with more bat speed."}`,
    ` Against EV over expected, body size explains little (best: ${BODY_X[evoeX].label.toLowerCase()}, r ${fmt.f2(r(evoeX, "evoe"))}). Size mostly buys speed, not better transfer.`,
  ].join("");
}

function scatter(container, legendEl, statEl, pts, fit, xKey, yKey, { onSelect, selectedId }) {
  const X = BODY_X[xKey], Y = BODY_Y[yKey];
  const small = container.clientWidth < 600;
  const m = { t: 22, r: small ? 12 : 28, b: 46, l: 52 };
  const { svg, g, w, h } = frame(container, small ? 360 : 440, m);
  svg.attr("aria-label", `Scatter of ${pts.length} hitters: ${X.label} vs ${Y.label}`);
  if (pts.length < 5) {
    g.append("text").attr("x", w / 2).attr("y", h / 2).attr("text-anchor", "middle").attr("class", "axis-label").text("Not enough hitters in this filter");
    setKids(legendEl); statEl.textContent = "";
    return;
  }
  const xs = d3.extent(pts, (d) => d.x);
  const pad = (xs[1] - xs[0]) * 0.03 || 1;
  const x = d3.scaleLinear().domain([xs[0] - pad, xs[1] + pad]).nice().range([0, w]);
  const y = d3.scaleLinear().domain(d3.extent(pts, (d) => d.y)).nice().range([h, 0]);
  axes(g, x, y, w, h, { xLabel: X.axis, yLabel: Y.axis, xFmt: xKey === "ht" ? (v) => feetInches(v) : xKey === "htwt" ? d3.format(".2f") : null });

  const ink = cssVar("--ink-2");
  g.append("line").attr("x1", x(x.domain()[0])).attr("x2", x(x.domain()[1]))
    .attr("y1", y(fit.predict(x.domain()[0]))).attr("y2", y(fit.predict(x.domain()[1])))
    .attr("stroke", ink).attr("stroke-width", 2).attr("stroke-linecap", "round");

  const color = divergingScale(2);
  const surface = cssVar("--surface");
  const placed = pts.map((d) => ({ ...d, px: x(d.x + X.jitter * 2 * jitterOf(d.id)), py: y(d.y) }));
  const outliers = new Set([...placed].sort((a, b) => b.z - a.z).slice(0, 4).concat([...placed].sort((a, b) => a.z - b.z).slice(0, 4)).map((d) => d.id));
  const ordered = [...placed].sort((a, b) => (outliers.has(a.id) || a.id === selectedId) - (outliers.has(b.id) || b.id === selectedId));
  g.append("g").selectAll("circle").data(ordered).join("circle")
    .attr("cx", (d) => d.px).attr("cy", (d) => d.py)
    .attr("r", (d) => (d.id === selectedId ? 8 : isOutlier(d.z) ? 6 : 4.5))
    .attr("fill", (d) => (d.id === selectedId ? cssVar("--select-fill") : color(d.z)))
    .attr("stroke", (d) => (d.id === selectedId ? cssVar("--select-ring") : isOutlier(d.z) ? cssVar("--ink") : surface))
    .attr("stroke-width", (d) => (d.id === selectedId ? 3 : 1.5));
  const hoverRing = g.append("circle").attr("r", 9).attr("fill", "none").attr("stroke", cssVar("--ink")).attr("stroke-width", 1.5).attr("visibility", "hidden").attr("pointer-events", "none");

  // Direct labels on the four biggest outliers each way (skip collisions).
  const boxes = [];
  const lg = g.append("g").attr("pointer-events", "none");
  for (const p of placed.filter((d) => outliers.has(d.id) || d.id === selectedId).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))) {
    const t = lg.append("text").attr("class", "dot-label").attr("x", p.px + 10).attr("y", p.py + 4).text(p.name);
    const padded = () => { const b = t.node().getBBox(); return { x: b.x - 6, y: b.y - 2, width: b.width + 12, height: b.height + 4 }; };
    let bb = padded();
    if (bb.x + bb.width > w) { t.attr("x", p.px - 10).attr("text-anchor", "end"); bb = padded(); }
    if (boxes.some((b) => !(bb.x > b.x + b.width || bb.x + bb.width < b.x || bb.y > b.y + b.height || bb.y + bb.height < b.y))) { t.remove(); continue; }
    boxes.push(bb);
  }

  nearestLayer(g, w, h, placed, 28,
    (event, p) => {
      hoverRing.attr("cx", p.px).attr("cy", p.py).attr("visibility", "visible");
      showTip(event, p.name, [
        ["Height · weight", `${feetInches(p.ht)} · ${show(p.wt, fmt.f0)} lb`],
        ["Height ÷ weight", d3.format(".3f")(p.htwt)],
        [Y.label, `${Y.f(p.y)} ${Y.unit}`],
        [`Expected from ${X.label.toLowerCase()}`, `${Y.f(p.pred)} ${Y.unit}`],
        ["Difference", `${fmt.s1(p.y - p.pred)} ${Y.unit} (${d3.format("+.1f")(p.z)} SD)`],
        ["Batted balls", fmt.int(p.n)],
      ], "Click to open this hitter");
    },
    () => { hoverRing.attr("visibility", "hidden"); hideTip(); },
    (p) => onSelect(p.id));

  const slope = fit.beta[1] * X.step;
  const r = pearson(pts.map((d) => d.x), pts.map((d) => d.y));
  statEl.textContent = `r ${fmt.f2(r.r)} · ${fmt.int(pts.length)} hitters · each ${X.per} of ${X.label.toLowerCase()} ≈ ${fmt.s2(slope)} ${Y.unit} of ${Y.lc}`;
  const stops = d3.range(0, 1.01, 0.1).map((t) => color(-2 + t * 4));
  setKids(legendEl,
    el("span", { class: "key" }, el("span", { class: "swatch-line", style: `background:${ink}` }), `Expected from ${X.label.toLowerCase()} (straight-line fit)`),
    el("span", { class: "key" },
      el("span", {}, `Dot color: ${Y.lc} vs that line`),
      el("span", {},
        el("span", { class: "ramp", style: `display:block;background:linear-gradient(90deg,${stops.join(",")})` }),
        el("span", { class: "ramp-labels" }, el("span", {}, "−2 SD"), el("span", {}, "0"), el("span", {}, "+2 SD")))),
    el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `border:1.5px solid ${cssVar("--ink")}` }), "Outlier (2+ SD)"),
    xKey !== "htwt" ? el("span", { class: "muted" }, "Points nudged sideways slightly so equal listed sizes don't stack.") : null,
  );
}

function outlierLists(container, pts, xKey, yKey, onSelect) {
  const X = BODY_X[xKey], Y = BODY_Y[yKey];
  const row = (d, i) => el("tr", { tabindex: "0", onclick: () => onSelect(d.id), onkeydown: (e) => { if (e.key === "Enter") onSelect(d.id); } },
    el("td", { class: "l rank" }, i + 1),
    el("td", { class: "l" }, el("span", { class: "pname" }, d.name), el("span", { class: "meta" }, `${d.team} · ${d.pos || d.bats}`)),
    el("td", {}, X.f(d.x)),
    el("td", {}, Y.f(d.y)),
    el("td", {}, Y.f(d.pred)),
    el("td", {}, el("b", {}, fmt.s1(d.y - d.pred))),
    el("td", {}, isOutlier(d.z) ? el("span", { class: "tag flag", title: "2+ SD from the fit" }, d3.format("+.1f")(d.z)) : d3.format("+.1f")(d.z)));
  const table = (list) => el("div", { class: "table-wrap" }, el("table", { class: "board" },
    el("thead", {}, el("tr", {},
      el("th", { class: "l rank" }, "#"), el("th", { class: "l" }, "Hitter"), el("th", {}, X.label),
      el("th", {}, Y.label), el("th", {}, "Expected"), el("th", {}, "Diff"), el("th", {}, "SD"))),
    el("tbody", {}, list.map(row))));
  const sorted = [...pts].sort((a, b) => b.z - a.z);
  const n = Math.min(8, Math.floor(sorted.length / 2));
  container.replaceChildren(
    el("div", {}, el("h3", {}, `More ${Y.lc} than ${X.label.toLowerCase()} predicts`),
      el("p", { class: "sub" }, "Over-performers for their size: where to look for movement that creates speed or exit velo beyond the frame."),
      table(sorted.slice(0, n))),
    el("div", {}, el("h3", {}, `Less ${Y.lc} than ${X.label.toLowerCase()} predicts`),
      el("p", { class: "sub" }, "Under-performers: the size is there, the output isn't."),
      table(sorted.slice(-n).reverse())),
  );
}

export function renderBody({ matrixEl, takeawayEl, scatterEl, legendEl, statEl, outliersEl }, rows, state, { onPick, onSelect }) {
  const cells = matrix(matrixEl, rows, state, onPick);
  takeawayEl.textContent = takeaway(cells);
  const xKey = state.bodyX, yKey = state.bodyY;
  const valid = rows.filter((h) => !nil(h[xKey]) && !nil(h[yKey]));
  const fit = valid.length >= 5 ? linFit(valid.map((h) => h[xKey]), valid.map((h) => h[yKey])) : null;
  const pts = fit ? valid.map((h) => ({ ...h, x: h[xKey], y: h[yKey], pred: fit.predict(h[xKey]) })) : [];
  const sd = d3.deviation(pts, (d) => d.y - d.pred) || 1;
  pts.forEach((d) => { d.z = (d.y - d.pred) / sd; });
  scatter(scatterEl, legendEl, statEl, pts, fit || { predict: () => 0, beta: [0, 0, 0] }, xKey, yKey, { onSelect, selectedId: state.player });
  if (pts.length >= 10) outlierLists(outliersEl, pts, xKey, yKey, onSelect);
  else outliersEl.replaceChildren(el("p", { class: "empty" }, "Not enough hitters in this filter to rank outliers."));
}

/** Residuals of bat speed and avg EV on height + weight together, for the leaderboard. */
export function sizeResiduals(pool) {
  const ok = pool.filter((h) => !nil(h.ht) && !nil(h.wt));
  if (ok.length < 10) return;
  for (const k of ["bs", "ev"]) {
    const fit = linFit(ok.map((h) => h.ht), ok.map((h) => h[k]), ok.map((h) => h.wt));
    for (const h of pool) h[`${k}_vs_size`] = nil(h.ht) || nil(h.wt) ? null : h[k] - fit.predict(h.ht, h.wt);
  }
}
