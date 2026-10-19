/* D3 charts. Each function fully re-renders into its container. */
/* global d3 */
import { fmt, show, cssVar, divergingScale, showTip, hideTip, quadFit, el, pctOrd, PITCH_NAMES } from "./lib.js";

export const setKids = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean));

export function frame(container, height, margin) {
  const width = Math.max(280, container.clientWidth);
  const svg = d3.select(container).selectAll("svg").data([0]).join("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img");
  svg.selectAll("*").remove();
  const inner = { w: width - margin.l - margin.r, h: height - margin.t - margin.b };
  const g = svg.append("g").attr("transform", `translate(${margin.l},${margin.t})`);
  return { svg, g, width, height, ...inner };
}

export function axes(g, x, y, w, h, { xLabel, yLabel, xTicks = 8, yTicks = 6, yFmt, xFmt } = {}) {
  g.append("g").attr("class", "grid")
    .call(d3.axisLeft(y).ticks(yTicks).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(xTicks).tickSizeOuter(0).tickFormat(xFmt || null));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(yTicks).tickSizeOuter(0).tickFormat(yFmt || null))
    .call((s) => s.select(".domain").remove());
  if (xLabel) g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 36).attr("text-anchor", "end").text(xLabel);
  if (yLabel) g.append("text").attr("class", "axis-label").attr("x", 0).attr("y", -6).text(yLabel);
}

/** Pointer -> nearest point within radius, via Delaunay. */
export function nearestLayer(g, w, h, pts, radius, onHover, onLeave, onClick) {
  const delaunay = d3.Delaunay.from(pts, (p) => p.px, (p) => p.py);
  let current = null;
  const pick = (event) => {
    const [mx, my] = d3.pointer(event, g.node());
    const i = delaunay.find(mx, my);
    const p = pts[i];
    return p && Math.hypot(p.px - mx, p.py - my) <= radius ? p : null;
  };
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .style("cursor", "crosshair")
    .on("pointermove", (event) => {
      const p = pick(event);
      if (p !== current) { current = p; if (!p) onLeave(); }
      if (p) onHover(event, p);
    })
    .on("pointerleave", () => { current = null; onLeave(); })
    .on("click", (event) => { const p = pick(event); if (p && onClick) onClick(p); });
}

/* ------------------------------------------------------------------ hitter scatter */
const Y_META = {
  ev: { label: "Avg exit velo (mph)", key: "ev", line: "Expected for that bat speed" },
  ev90: { label: "EV90 — 90th pct exit velo (mph)", key: "ev90", line: "Expected EV90 for that bat speed" },
  evoe: { label: "EV over expected (mph)", key: "evoe", line: "League expectation (0)" },
};

export function hitterScatter(container, legendEl, rows, { yMode, selectedId, compId, onSelect, colorLimit }) {
  const meta = Y_META[yMode];
  const small = container.clientWidth < 600;
  const m = { t: 22, r: small ? 12 : 28, b: 46, l: 50 };
  const { svg, g, w, h } = frame(container, small ? 380 : 480, m);
  svg.attr("aria-label", `Scatter of ${rows.length} hitters: average bat speed vs ${meta.label}`);
  if (!rows.length) {
    g.append("text").attr("x", w / 2).attr("y", h / 2).attr("text-anchor", "middle").attr("class", "axis-label").text("No hitters match these filters");
    setKids(legendEl);
    return;
  }
  const x = d3.scaleLinear().domain(d3.extent(rows, (d) => d.bs)).nice().range([0, w]);
  const y = d3.scaleLinear().domain(d3.extent(rows, (d) => d[meta.key])).nice().range([h, 0]);
  axes(g, x, y, w, h, { xLabel: "Avg bat speed, competitive batted balls (mph)", yLabel: meta.label });

  // Expected line
  if (yMode === "evoe") {
    g.append("line").attr("x1", 0).attr("x2", w).attr("y1", y(0)).attr("y2", y(0))
      .attr("stroke", cssVar("--ink-2")).attr("stroke-width", 2).attr("stroke-linecap", "round");
  } else if (rows.length > 8) {
    const f = quadFit(rows.map((d) => d.bs), rows.map((d) => d[meta.key]), rows.map((d) => Math.sqrt(d.n)));
    const xs = d3.range(x.domain()[0], x.domain()[1] + 0.01, 0.25);
    g.append("path").datum(xs)
      .attr("fill", "none").attr("stroke", cssVar("--ink-2")).attr("stroke-width", 2).attr("stroke-linecap", "round")
      .attr("d", d3.line().x((v) => x(v)).y((v) => y(f(v))));
  }

  const color = divergingScale(colorLimit);
  const surface = cssVar("--surface");
  const pts = rows.map((d) => ({ ...d, px: x(d.bs), py: y(d[meta.key]) }));
  const ordered = [...pts].sort((a, b) => (a.id === selectedId || a.id === compId) - (b.id === selectedId || b.id === compId));
  const dots = g.append("g");
  dots.selectAll("circle").data(ordered, (d) => d.id).join("circle")
    .attr("cx", (d) => d.px).attr("cy", (d) => d.py)
    .attr("r", (d) => (d.id === selectedId || d.id === compId ? 8 : 4.5))
    .attr("fill", (d) => (d.id === selectedId ? cssVar("--select-fill") : color(d.evoe)))
    .attr("stroke", (d) => (d.id === selectedId ? cssVar("--select-ring") : d.id === compId ? cssVar("--neg") : surface))
    .attr("stroke-width", (d) => (d.id === selectedId || d.id === compId ? 3 : 1.5));
  const hoverRing = g.append("circle").attr("r", 9).attr("fill", "none").attr("stroke", cssVar("--ink")).attr("stroke-width", 1.5).attr("visibility", "hidden").attr("pointer-events", "none");

  // Selective direct labels: top 5 by EV over expected, plus selected/comp. Skip collisions.
  const labeled = [...pts].sort((a, b) => b.evoe - a.evoe).slice(0, 5);
  for (const id of [compId, selectedId]) {
    const p = pts.find((d) => d.id === id);
    if (p && !labeled.includes(p)) labeled.unshift(p);
  }
  const boxes = [];
  const lg = g.append("g").attr("pointer-events", "none");
  for (const p of labeled) {
    const t = lg.append("text").attr("class", "dot-label").attr("x", p.px + 10).attr("y", p.py + 4).text(p.name);
    let bb = t.node().getBBox();
    if (bb.x + bb.width > w) { t.attr("x", p.px - 10).attr("text-anchor", "end"); bb = t.node().getBBox(); }
    if (boxes.some((b) => !(bb.x > b.x + b.width || bb.x + bb.width < b.x || bb.y > b.y + b.height || bb.y + bb.height < b.y))) {
      if (p.id !== selectedId && p.id !== compId) { t.remove(); continue; }
    }
    boxes.push(bb);
  }

  nearestLayer(g, w, h, pts, 28,
    (event, p) => {
      hoverRing.attr("cx", p.px).attr("cy", p.py).attr("visibility", "visible");
      showTip(event, p.name, [
        ["Team · bats", `${p.team} · ${p.bats}`],
        ["Batted balls", fmt.int(p.n)],
        ["Avg bat speed", `${fmt.f1(p.bs)} mph`],
        ["Avg EV / expected", `${fmt.f1(p.ev)} / ${fmt.f1(p.xev)}`],
        ["EV over expected", `${fmt.s1(p.evoe)} mph`],
        ["Bat-adjusted", p.bat_src === "assumed" ? `${fmt.s1(p.evoe_bat)} mph (std bat assumed)` : `${fmt.s1(p.evoe_bat)} mph (${fmt.f0(p.bat_len)} in / ${fmt.f0(p.bat_oz)} oz)`],
        ["EV90 over expected", `${show(p.top, fmt.s1)} mph`],
        ["Same-speed peer rank", p.peerPct === null ? "–" : `${pctOrd(p.peerPct)} pct`],
      ], "Click to open this hitter");
    },
    () => { hoverRing.attr("visibility", "hidden"); hideTip(); },
    (p) => onSelect(p.id));

  // Legend: line key + diverging ramp
  const stops = d3.range(0, 1.01, 0.1).map((t) => color(-colorLimit + t * 2 * colorLimit));
  setKids(legendEl,
    el("span", { class: "key" }, el("span", { class: "swatch-line", style: `background:${cssVar("--ink-2")}` }), meta.line),
    el("span", { class: "key" },
      el("span", {}, "Dot color: EV over expected"),
      el("span", {},
        el("span", { class: "ramp", style: `display:block;background:linear-gradient(90deg,${stops.join(",")})` }),
        el("span", { class: "ramp-labels" }, el("span", {}, `−${colorLimit}`), el("span", {}, "0"), el("span", {}, `+${colorLimit} mph`)))),
    rows.some((d) => d.id === selectedId) ? el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `background:${cssVar("--select-fill")};outline:2px solid ${cssVar("--select-ring")}` }), "Selected") : null,
    rows.some((d) => d.id === compId) ? el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `border:2.5px solid ${cssVar("--neg")}` }), "Comparison") : null,
  );
}

/* ------------------------------------------------------------------ swing scatter */
export function swingScatter(container, legendEl, { swings, comp, curves, density, selected, onPick, names }) {
  const small = container.clientWidth < 520;
  const m = { t: 20, r: small ? 34 : 44, b: 46, l: 46 };
  const { svg, g, w, h } = frame(container, small ? 360 : 420, m);
  svg.attr("aria-label", "Each batted ball's bat speed and exit velocity against the league distribution");
  const x = d3.scaleLinear().domain([58, 86]).range([0, w]);
  const y = d3.scaleLinear().domain([40, 120]).range([h, 0]);
  axes(g, x, y, w, h, { xLabel: "Bat speed (mph)", yLabel: "Exit velo (mph)" });

  // League density
  const cells = [];
  density.counts.forEach((col, i) => col.forEach((c, j) => {
    const bs = density.bs0 + i * density.bsStep, ev = density.ev0 + j * density.evStep;
    if (c > 0 && bs >= 58 && bs < 86 && ev >= 40 && ev < 120) cells.push({ bs, ev, c });
  }));
  const cmax = d3.max(cells, (d) => d.c) || 1;
  const dens = cssVar("--density");
  g.append("g").attr("pointer-events", "none").selectAll("rect").data(cells).join("rect")
    .attr("x", (d) => x(d.bs)).attr("y", (d) => y(d.ev + density.evStep))
    .attr("width", x(59) - x(58) + 0.5).attr("height", y(40) - y(40 + density.evStep) + 0.5)
    .attr("fill", dens).attr("opacity", (d) => 0.03 + 0.32 * Math.sqrt(d.c / cmax));

  // League percentile curves
  const ink = cssVar("--ink-2");
  const line = (k) => d3.line().defined((_, i) => curves[k][i] !== null && curves.bs[i] >= 58 && curves.bs[i] <= 86)
    .x((_, i) => x(curves.bs[i])).y((_, i) => y(curves[k][i]));
  const lines = [["p90", 1.25, "90th"], ["p50", 2, "Median"], ["p10", 1.25, "10th"]];
  for (const [k, sw, lab] of lines) {
    g.append("path").datum(curves[k]).attr("fill", "none").attr("stroke", ink).attr("stroke-width", sw)
      .attr("stroke-opacity", k === "p50" ? 0.9 : 0.6).attr("stroke-linecap", "round").attr("d", line(k));
    let last = -1;
    curves[k].forEach((v, i) => { if (v !== null && curves.bs[i] <= 86) last = i; });
    if (last >= 0) {
      g.append("text").attr("class", "axis-label").attr("x", x(curves.bs[last]) + 4).attr("y", y(curves[k][last]) + 4)
        .style("text-transform", "none").text(lab);
    }
  }

  const surface = cssVar("--surface");
  const visible = (s) => s.bs >= 58 && s.bs <= 86 && s.ev >= 40 && s.ev <= 120;
  const toPts = (arr, who) => arr.filter(visible).map((s) => ({ ...s, who, px: x(s.bs), py: y(s.ev) }));
  const pts = [...toPts(comp || [], "comp"), ...toPts(swings, "main")];
  const gd = g.append("g").attr("pointer-events", "none");
  gd.selectAll("circle").data(pts).join("circle")
    .attr("cx", (d) => d.px).attr("cy", (d) => d.py).attr("r", 3.5)
    .attr("fill", (d) => (d.who === "comp" ? cssVar("--neg") : cssVar("--pos")))
    .attr("fill-opacity", 0.85)
    .attr("stroke", surface).attr("stroke-width", 1);
  if (selected && visible(selected)) {
    g.append("circle").attr("cx", x(selected.bs)).attr("cy", y(selected.ev)).attr("r", 8)
      .attr("fill", cssVar("--select-fill")).attr("stroke", cssVar("--select-ring")).attr("stroke-width", 3).attr("pointer-events", "none");
  }
  const hoverRing = g.append("circle").attr("r", 7).attr("fill", "none").attr("stroke", cssVar("--ink")).attr("stroke-width", 1.5).attr("visibility", "hidden").attr("pointer-events", "none");

  nearestLayer(g, w, h, pts, 16,
    (event, p) => {
      hoverRing.attr("cx", p.px).attr("cy", p.py).attr("visibility", "visible");
      showTip(event, `${p.who === "comp" ? names.comp : names.main} · ${p.date}`, [
        ["Pitch", `${PITCH_NAMES[p.pt] || p.pt || "–"} ${show(p.ps, fmt.f1)} mph`],
        ["Bat speed", `${fmt.f1(p.bs)} mph`],
        ["Exit velo / expected", `${fmt.f1(p.ev)} / ${fmt.f1(p.xev)}`],
        ["vs expected", `${fmt.s1(p.r)} mph`],
        ["EV pct at this bat speed", p.cp === null ? "–" : pctOrd(p.cp / 100)],
        ["Launch / attack angle", `${show(p.la, fmt.f0)}° / ${show(p.aa, fmt.f0)}°`],
        ["Result", p.res],
      ], "Click for details and video");
    },
    () => { hoverRing.attr("visibility", "hidden"); hideTip(); },
    (p) => onPick(p));

  setKids(legendEl,
    el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `background:${cssVar("--pos")}` }), names.main),
    comp ? el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `background:${cssVar("--neg")}` }), names.comp) : null,
    el("span", { class: "key" }, el("span", { class: "swatch-line", style: `background:${ink}` }), "League 10th / median / 90th pct EV at each bat speed"),
    el("span", { class: "key" }, el("span", { class: "swatch-dot", style: `background:${dens};opacity:.35;border-radius:2px` }), "League batted balls"),
  );
}

/* ------------------------------------------------------------------ driver small multiples */
export function driverMultiples(container, drivers, view) {
  container.replaceChildren();
  const all = drivers.flatMap((d) => d.bins.flatMap((b) => [b.resid - b.ci, b.resid + b.ci]));
  const yDomain = [Math.max(-24, Math.floor(d3.min(all))), Math.min(10, Math.ceil(d3.max(all)))];
  for (const d of drivers) {
    const box = el("div", { class: "multiple" }, el("h4", {}, d.label), el("p", {}, d.desc));
    const chart = el("div", { class: "chart" });
    box.append(chart);
    container.append(box);
    if (view === "table") {
      const t = el("table", { class: "board compact" },
        el("thead", {}, el("tr", {}, el("th", { class: "l" }, "Bin"), el("th", {}, "EV vs exp"), el("th", {}, "± 95%"), el("th", {}, "Sq-up"), el("th", {}, "Balls"))),
        el("tbody", {}, d.bins.map((b) => el("tr", {},
          el("td", { class: "l" }, fmt.f1(b.x)), el("td", {}, fmt.s1(b.resid)), el("td", {}, fmt.f1(b.ci)),
          el("td", {}, fmt.pct(b.sq)), el("td", {}, fmt.int(b.n))))));
      chart.append(el("div", { class: "table-wrap" }, t));
      continue;
    }
    const m = { t: 14, r: 10, b: 30, l: 36 };
    const { g, w, h, svg } = frame(chart, 190, m);
    svg.attr("aria-label", `${d.label}: exit velo vs expected by bin`);
    const x = d3.scaleLinear().domain(d3.extent(d.bins, (b) => b.x)).range([0, w]);
    const y = d3.scaleLinear().domain(yDomain).range([h, 0]);
    axes(g, x, y, w, h, { xTicks: 5, yTicks: 5, yFmt: (v) => (v > 0 ? `+${v}` : v) });
    g.append("line").attr("x1", 0).attr("x2", w).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", cssVar("--axis")).attr("stroke-width", 1);
    const pos = cssVar("--pos");
    g.append("path").datum(d.bins).attr("fill", pos).attr("fill-opacity", 0.14)
      .attr("d", d3.area().x((b) => x(b.x)).y0((b) => y(b.resid - b.ci)).y1((b) => y(b.resid + b.ci)));
    g.append("path").datum(d.bins).attr("fill", "none").attr("stroke", pos).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("stroke-linecap", "round")
      .attr("d", d3.line().x((b) => x(b.x)).y((b) => y(b.resid)));
    // peak marker + label
    const best = d3.greatest(d.bins, (b) => b.resid);
    g.append("circle").attr("cx", x(best.x)).attr("cy", y(best.resid)).attr("r", 4).attr("fill", pos).attr("stroke", cssVar("--surface")).attr("stroke-width", 2);
    const cross = g.append("line").attr("y1", 0).attr("y2", h).attr("stroke", cssVar("--ink-2")).attr("stroke-width", 1).attr("visibility", "hidden");
    const dot = g.append("circle").attr("r", 4).attr("fill", pos).attr("stroke", cssVar("--surface")).attr("stroke-width", 2).attr("visibility", "hidden");
    g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
      .on("pointermove", (event) => {
        const [mx] = d3.pointer(event);
        const b = d3.least(d.bins, (q) => Math.abs(x(q.x) - mx));
        cross.attr("x1", x(b.x)).attr("x2", x(b.x)).attr("visibility", "visible");
        dot.attr("cx", x(b.x)).attr("cy", y(b.resid)).attr("visibility", "visible");
        showTip(event, `${d.label.split(" (")[0]}: ${fmt.f1(b.x)}`, [
          ["EV vs expected", `${fmt.s1(b.resid)} mph (± ${fmt.f1(b.ci)})`],
          ["Squared-up rate", fmt.pct(b.sq)],
          ["Batted balls", fmt.int(b.n)],
        ]);
      })
      .on("pointerleave", () => { cross.attr("visibility", "hidden"); dot.attr("visibility", "hidden"); hideTip(); });
  }
}

/* ------------------------------------------------------------------ contact map */
export function contactMap(container, legendEl, cm) {
  const small = container.clientWidth < 480;
  const m = { t: 26, r: 12, b: 48, l: 48 };
  const { g, w, h, svg } = frame(container, small ? 330 : 390, m);
  svg.attr("aria-label", "Heatmap of exit velo vs expected by horizontal and vertical face-to-path gap");
  const x = d3.scaleLinear().domain([cm.x0, cm.x0 + cm.nx * cm.xStep]).range([0, w]);
  const y = d3.scaleLinear().domain([cm.y0, cm.y0 + cm.ny * cm.yStep]).range([h, 0]);
  const lim = 10;
  const color = divergingScale(lim);
  const surface = cssVar("--surface");
  const cells = cm.cells.map(([i, j, v, n]) => ({ x0: cm.x0 + i * cm.xStep, y0: cm.y0 + j * cm.yStep, v, n }));
  g.selectAll("rect").data(cells).join("rect")
    .attr("x", (c) => x(c.x0) + 1).attr("y", (c) => y(c.y0 + cm.yStep) + 1)
    .attr("width", x(cm.x0 + cm.xStep) - x(cm.x0) - 2).attr("height", y(cm.y0) - y(cm.y0 + cm.yStep) - 2)
    .attr("rx", 2).attr("fill", (c) => color(c.v)).attr("stroke", surface).attr("stroke-width", 0)
    .on("pointermove", function (event, c) {
      d3.select(this).attr("stroke", cssVar("--ink")).attr("stroke-width", 1.5);
      showTip(event, `${fmt.f0(c.x0)}° to ${fmt.f0(c.x0 + cm.xStep)}° horiz · ${fmt.f0(c.y0)}° to ${fmt.f0(c.y0 + cm.yStep)}° vert`, [
        ["EV vs expected", `${fmt.s1(c.v)} mph`], ["Batted balls", fmt.int(c.n)],
      ]);
    })
    .on("pointerleave", function () { d3.select(this).attr("stroke-width", 0); hideTip(); });
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(small ? 5 : 8).tickSizeOuter(0));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(8).tickSizeOuter(0)).call((s) => s.select(".domain").remove());
  g.append("text").attr("class", "axis-label").attr("x", 0).attr("y", h + 38).text("← more pull than path");
  g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 38).attr("text-anchor", "end").text("more oppo than path →");
  g.append("text").attr("class", "axis-label").attr("x", 0).attr("y", -10).text("Launch − attack angle (°): + undercut / − topped");
  const stops = d3.range(0, 1.01, 0.1).map((t) => color(-lim + t * 2 * lim));
  setKids(legendEl, el("span", { class: "key" },
    el("span", {}, "EV vs expected"),
    el("span", {},
      el("span", { class: "ramp", style: `display:block;background:linear-gradient(90deg,${stops.join(",")})` }),
      el("span", { class: "ramp-labels" }, el("span", {}, `−${lim}`), el("span", {}, "0"), el("span", {}, `+${lim} mph`)))));
}

/* ------------------------------------------------------------------ hitter-level correlations */
export function correlationBars(container, legendEl, list) {
  const small = container.clientWidth < 480;
  const labelW = small ? 150 : 210;
  const rowH = 26;
  const m = { t: 8, r: 40, b: 30, l: labelW };
  const { g, w, h, svg } = frame(container, list.length * rowH + m.t + m.b, m);
  svg.attr("aria-label", "Correlation of hitter traits with EV over expected");
  const lim = Math.max(0.4, Math.ceil(d3.max(list, (d) => Math.abs(d.r_evoe)) * 10) / 10);
  const x = d3.scaleLinear().domain([-lim, lim]).range([0, w]);
  const y = d3.scaleBand().domain(list.map((d) => d.key)).range([0, h]).padding(0.3);
  g.append("g").attr("class", "grid").call(d3.axisBottom(x).ticks(5).tickSize(h).tickFormat(""));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(5).tickSizeOuter(0).tickFormat(d3.format("+.1f")));
  g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", h).attr("stroke", cssVar("--axis"));
  const pos = cssVar("--pos");
  const bh = Math.min(16, y.bandwidth());
  const bar = g.selectAll("g.bar").data(list).join("g").attr("class", "bar")
    .attr("transform", (d) => `translate(0,${y(d.key) + (y.bandwidth() - bh) / 2})`);
  bar.append("path").attr("fill", pos).attr("d", (d) => {
    const x0 = x(0), x1 = x(d.r_evoe), r = Math.min(4, Math.abs(x1 - x0));
    const dir = x1 >= x0 ? 1 : -1;
    return `M${x0},0 H${x1 - dir * r} Q${x1},0 ${x1},${r} V${bh - r} Q${x1},${bh} ${x1 - dir * r},${bh} H${x0} Z`;
  });
  bar.append("text").attr("class", "axis-label").style("text-transform", "none").style("letter-spacing", "0")
    .attr("x", (d) => x(d.r_evoe) + (d.r_evoe >= 0 ? 6 : -6)).attr("y", bh / 2 + 4)
    .attr("text-anchor", (d) => (d.r_evoe >= 0 ? "start" : "end")).text((d) => d3.format("+.2f")(d.r_evoe));
  g.selectAll("text.lab").data(list).join("text").attr("class", "lab")
    .attr("x", -10).attr("y", (d) => y(d.key) + y.bandwidth() / 2 + 4).attr("text-anchor", "end")
    .attr("fill", cssVar("--ink-2")).style("font", "500 13px var(--body)").text((d) => d.label);
  g.append("g").selectAll("rect").data(list).join("rect")
    .attr("x", -labelW).attr("width", w + labelW).attr("y", (d) => y(d.key)).attr("height", y.bandwidth()).attr("fill", "transparent")
    .on("pointermove", (event, d) => showTip(event, d.label, [
      ["r with EV over expected", d3.format("+.2f")(d.r_evoe)],
      ["r with EV90 over expected", d3.format("+.2f")(d.r_top)],
      ["Hitter-seasons", fmt.int(d.n)],
    ]))
    .on("pointerleave", hideTip);
  setKids(legendEl, el("span", { class: "muted" }, "Bars: correlation (r) with EV over expected. Hover for the EV90 version. Correlation, not causation."));
}

/* ------------------------------------------------------------------ peer strip (path profile row) */
export function peerStrip(container, { peers, efficient, value, compValue }) {
  const m = { t: 6, r: 8, b: 6, l: 8 };
  const { g, w, h, svg } = frame(container, 30, m);
  svg.attr("aria-hidden", "true");
  const vals = [...peers, value, compValue].filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!vals.length) return;
  const x = d3.scaleLinear().domain(d3.extent(vals)).nice().range([0, w]);
  g.append("line").attr("x1", 0).attr("x2", w).attr("y1", h / 2).attr("y2", h / 2).attr("stroke", cssVar("--grid")).attr("stroke-width", 6).attr("stroke-linecap", "round");
  g.selectAll("line.p").data(peers).join("line").attr("class", "p")
    .attr("x1", (v) => x(v)).attr("x2", (v) => x(v)).attr("y1", h / 2 - 5).attr("y2", h / 2 + 5)
    .attr("stroke", cssVar("--muted")).attr("stroke-opacity", 0.45).attr("stroke-width", 1);
  g.selectAll("line.e").data(efficient).join("line").attr("class", "e")
    .attr("x1", (v) => x(v)).attr("x2", (v) => x(v)).attr("y1", h / 2 - 8).attr("y2", h / 2 + 8)
    .attr("stroke", cssVar("--pos")).attr("stroke-width", 2).attr("stroke-linecap", "round");
  if (efficient.length) {
    const em = d3.mean(efficient);
    g.append("path").attr("d", d3.symbol(d3.symbolTriangle, 50)()).attr("transform", `translate(${x(em)},${h / 2 - 11}) rotate(180)`).attr("fill", cssVar("--pos"));
  }
  if (compValue !== null && compValue !== undefined && !Number.isNaN(compValue)) {
    g.append("circle").attr("cx", x(compValue)).attr("cy", h / 2).attr("r", 6).attr("fill", cssVar("--surface")).attr("stroke", cssVar("--neg")).attr("stroke-width", 3);
  }
  if (value !== null && value !== undefined && !Number.isNaN(value)) {
    g.append("circle").attr("cx", x(value)).attr("cy", h / 2).attr("r", 6.5).attr("fill", cssVar("--select-fill")).attr("stroke", cssVar("--select-ring")).attr("stroke-width", 2.5);
  }
}
