/* Reusable "hitter trait vs outcome" section: correlation matrix, scatter with fit and flagged
   outliers, over/under-performer tables, and (optionally) the most extreme values of the trait.
   Used by the body-size and batting-stance sections; each passes its own config. */
/* global d3 */
import { fmt, show, nil, el, cssVar, divergingScale, showTip, hideTip, linFit, pearson, pctOrd } from "./lib.js";
import { frame, axes, nearestLayer, setKids } from "./charts.js";

// Flag at the value that displays as 2.0 SD, so the table and chart agree with what's printed.
const isOutlier = (z) => Math.abs(z) >= 1.95;

// Stable per-hitter jitter so integer heights / 5-lb weights don't stack into columns.
const jitterOf = (id) => ((Math.sin(id * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5;

function textOn(fill) {
  const c = d3.rgb(fill);
  const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return lum > 0.55 ? "#152237" : "#ffffff";
}

/** r between two fields across hitters that have both. */
export function corr(rows, a, b) {
  const pts = rows.filter((h) => !nil(h[a]) && !nil(h[b]));
  return pearson(pts.map((h) => h[a]), pts.map((h) => h[b]));
}

/** r between a and b after removing what `control` explains in each (partial correlation). */
export function partialCorr(rows, a, b, control) {
  const pts = rows.filter((h) => !nil(h[a]) && !nil(h[b]) && !nil(h[control]));
  if (pts.length < 10) return NaN;
  const z = pts.map((h) => h[control]);
  const fa = linFit(z, pts.map((h) => h[a])), fb = linFit(z, pts.map((h) => h[b]));
  return pearson(pts.map((h) => h[a] - fa.predict(h[control])), pts.map((h) => h[b] - fb.predict(h[control]))).r;
}

function matrix(container, rows, cfg, sel, onPick) {
  const scale = divergingScale(0.6);
  const cells = {};
  for (const x of Object.keys(cfg.X)) for (const y of Object.keys(cfg.Y)) cells[`${x}|${y}`] = corr(rows, x, y);
  const table = el("table", { class: "corr-matrix" },
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, ""),
      Object.values(cfg.Y).map((m) => el("th", { scope: "col" }, m.label)))),
    el("tbody", {}, Object.entries(cfg.X).map(([x, xm]) => el("tr", {},
      el("th", { scope: "row" }, xm.label),
      Object.keys(cfg.Y).map((y) => {
        const c = cells[`${x}|${y}`];
        const bg = Number.isNaN(c.r) ? "transparent" : scale(c.r);
        const on = sel.xKey === x && sel.yKey === y;
        return el("td", {},
          el("button", {
            type: "button", class: `corr-cell${on ? " on" : ""}`, "aria-pressed": String(on),
            "aria-label": `${xm.label} vs ${cfg.Y[y].label}: r ${fmt.f2(c.r)}, ${c.n} hitters`,
            style: `background:${bg};color:${textOn(bg)}`,
            onclick: () => onPick(x, y),
            onpointermove: (e) => showTip(e, `${xm.label} vs ${cfg.Y[y].label}`, [
              ["r", d3.format("+.2f")(c.r)], ["95% range", `${d3.format("+.2f")(c.lo)} to ${d3.format("+.2f")(c.hi)}`],
              ["Share of variance", fmt.pct(c.r ** 2)], ["Hitters", fmt.int(c.n)],
            ], "Click to plot this pair"),
            onpointerleave: hideTip,
          }, Number.isNaN(c.r) ? "–" : d3.format("+.2f")(c.r)));
      }))))
  );
  container.replaceChildren(el("div", { class: "table-wrap" }, table));
  return (x, y) => cells[`${x}|${y}`].r;
}

function scatter(container, legendEl, statEl, pts, fit, cfg, xKey, yKey, { onSelect, selectedId }) {
  const X = cfg.X[xKey], Y = cfg.Y[yKey];
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
  axes(g, x, y, w, h, { xLabel: X.axis, yLabel: Y.axis, xFmt: X.tick || null });

  const ink = cssVar("--ink-2");
  g.append("line").attr("x1", x(x.domain()[0])).attr("x2", x(x.domain()[1]))
    .attr("y1", y(fit.predict(x.domain()[0]))).attr("y2", y(fit.predict(x.domain()[1])))
    .attr("stroke", ink).attr("stroke-width", 2).attr("stroke-linecap", "round");

  const color = divergingScale(2);
  const surface = cssVar("--surface");
  const placed = pts.map((d) => ({ ...d, px: x(d.x + (X.jitter || 0) * 2 * jitterOf(d.id)), py: y(d.y) }));
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
        ...cfg.tooltip(p),
        [Y.label, `${Y.f(p.y)} ${Y.unit}`],
        [`Expected from ${X.lc}`, `${Y.f(p.pred)} ${Y.unit}`],
        ["Difference", `${fmt.s1(p.y - p.pred)} ${Y.unit} (${d3.format("+.1f")(p.z)} SD)`],
        ["Batted balls", fmt.int(p.n)],
      ], "Click to open this hitter");
    },
    () => { hoverRing.attr("visibility", "hidden"); hideTip(); },
    (p) => onSelect(p.id));

  const slope = fit.beta[1] * X.step;
  const r = pearson(pts.map((d) => d.x), pts.map((d) => d.y));
  statEl.textContent = `r ${fmt.f2(r.r)} · ${fmt.int(pts.length)} hitters · each ${X.per} of ${X.lc} ≈ ${fmt.s2(slope)} ${Y.unit} of ${Y.lc}`;
  const stops = d3.range(0, 1.01, 0.1).map((t) => color(-2 + t * 4));
  setKids(legendEl,
    el("span", { class: "key" }, el("span", { class: "swatch-line", style: `background:${ink}` }), `Expected from ${X.lc} (straight-line fit)`),
    el("span", { class: "key" },
      el("span", {}, `Dot color: ${Y.lc} vs that line`),
      el("span", {},
        el("span", { class: "ramp", style: `display:block;background:linear-gradient(90deg,${stops.join(",")})` }),
        el("span", { class: "ramp-labels" }, el("span", {}, "−2 SD"), el("span", {}, "0"), el("span", {}, "+2 SD")))),
    el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `border:1.5px solid ${cssVar("--ink")}` }), "Outlier (2+ SD)"),
    X.jitter ? el("span", { class: "muted" }, "Points nudged sideways slightly so equal listed values don't stack.") : null,
  );
}

const rowLink = (d, onSelect, ...cells) => el("tr", { tabindex: "0", onclick: () => onSelect(d.id), onkeydown: (e) => { if (e.key === "Enter") onSelect(d.id); } }, ...cells);
const hitterCell = (d) => el("td", { class: "l" }, el("span", { class: "pname" }, d.name), el("span", { class: "meta" }, `${d.team} · ${d.pos || d.bats}`));

function outlierLists(container, pts, cfg, xKey, yKey, onSelect) {
  const X = cfg.X[xKey], Y = cfg.Y[yKey];
  const table = (list) => el("div", { class: "table-wrap" }, el("table", { class: "board" },
    el("thead", {}, el("tr", {},
      el("th", { class: "l rank" }, "#"), el("th", { class: "l" }, "Hitter"), el("th", {}, X.label),
      el("th", {}, Y.label), el("th", {}, "Expected"), el("th", {}, "Diff"), el("th", {}, "SD"))),
    el("tbody", {}, list.map((d, i) => rowLink(d, onSelect,
      el("td", { class: "l rank" }, i + 1), hitterCell(d),
      el("td", {}, X.f(d.x)), el("td", {}, Y.f(d.y)), el("td", {}, Y.f(d.pred)),
      el("td", {}, el("b", {}, fmt.s1(d.y - d.pred))),
      el("td", {}, isOutlier(d.z) ? el("span", { class: "tag flag", title: "2+ SD from the fit" }, d3.format("+.1f")(d.z)) : d3.format("+.1f")(d.z)))))));
  const sorted = [...pts].sort((a, b) => b.z - a.z);
  const n = Math.min(8, Math.floor(sorted.length / 2));
  const copy = cfg.outlierCopy(X, Y);
  container.replaceChildren(
    el("div", {}, el("h3", {}, copy.overTitle), el("p", { class: "sub" }, copy.overSub), table(sorted.slice(0, n))),
    el("div", {}, el("h3", {}, copy.underTitle), el("p", { class: "sub" }, copy.underSub), table(sorted.slice(-n).reverse())),
  );
}

/** The hitters with the most extreme values of the trait, with every outcome and its percentile. */
function extremeLists(container, rows, cfg, xKey, onSelect) {
  const X = cfg.X[xKey];
  const valid = rows.filter((h) => !nil(h[xKey]));
  if (valid.length < 12) { container.replaceChildren(); return; }
  const pctOf = {};
  for (const y of Object.keys(cfg.Y)) {
    const vals = valid.map((h) => h[y]).filter((v) => !nil(v)).sort(d3.ascending);
    pctOf[y] = (v) => (nil(v) ? null : d3.bisectLeft(vals, v) / Math.max(1, vals.length - 1));
  }
  const table = (list) => el("div", { class: "table-wrap" }, el("table", { class: "board" },
    el("thead", {}, el("tr", {},
      el("th", { class: "l rank" }, "#"), el("th", { class: "l" }, "Hitter"), el("th", {}, X.label),
      Object.values(cfg.Y).map((m) => el("th", {}, m.label)))),
    el("tbody", {}, list.map((d, i) => rowLink(d, onSelect,
      el("td", { class: "l rank" }, i + 1), hitterCell(d), el("td", {}, el("b", {}, X.f(d[xKey]))),
      Object.entries(cfg.Y).map(([y, m]) => {
        const p = pctOf[y](d[y]);
        return el("td", {}, show(d[y], m.f), p === null ? null : el("span", { class: "meta" }, pctOrd(p)));
      }))))));
  const sorted = [...valid].sort((a, b) => b[xKey] - a[xKey]);
  const n = Math.min(6, Math.floor(sorted.length / 2));
  container.replaceChildren(
    el("div", {}, el("h3", {}, X.hi), el("p", { class: "sub" }, "With each outcome and its percentile among these hitters."), table(sorted.slice(0, n))),
    el("div", {}, el("h3", {}, X.lo), el("p", { class: "sub" }, "With each outcome and its percentile among these hitters."), table(sorted.slice(-n).reverse())),
  );
}

/**
 * els: { matrixEl, takeawayEl, scatterEl, legendEl, statEl, outliersEl, extremesEl? }
 * cfg: { X, Y, takeaway(r, rows), tooltip(p), outlierCopy(X, Y) }
 * sel: { xKey, yKey, selectedId }
 */
export function renderTraits(els, rows, cfg, sel, { onPick, onSelect }) {
  const r = matrix(els.matrixEl, rows, cfg, sel, onPick);
  els.takeawayEl.textContent = cfg.takeaway(r, rows);
  const { xKey, yKey } = sel;
  const valid = rows.filter((h) => !nil(h[xKey]) && !nil(h[yKey]));
  const fit = valid.length >= 5 ? linFit(valid.map((h) => h[xKey]), valid.map((h) => h[yKey])) : null;
  const pts = fit ? valid.map((h) => ({ ...h, x: h[xKey], y: h[yKey], pred: fit.predict(h[xKey]) })) : [];
  const sd = d3.deviation(pts, (d) => d.y - d.pred) || 1;
  pts.forEach((d) => { d.z = (d.y - d.pred) / sd; });
  scatter(els.scatterEl, els.legendEl, els.statEl, pts, fit || { predict: () => 0, beta: [0, 0, 0] }, cfg, xKey, yKey, { onSelect, selectedId: sel.selectedId });
  if (pts.length >= 10) outlierLists(els.outliersEl, pts, cfg, xKey, yKey, onSelect);
  else els.outliersEl.replaceChildren(el("p", { class: "empty" }, "Not enough hitters in this filter to rank outliers."));
  if (els.extremesEl) extremeLists(els.extremesEl, rows, cfg, xKey, onSelect);
}

