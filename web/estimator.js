/* Bat speed estimator: average bat speed from exit velo readings, pitch speed and bat size.
   Calibration (meta.estimator) comes from MLB hitter-seasons in pipeline/build.py. */
/* global d3 */
import { fmt, el, cssVar, nil, pctOrd } from "./lib.js";
import { frame, setKids } from "./charts.js";

const STORE = "evlab-estimator";

/** Collision efficiency at the sweet spot, same model as pipeline/build.py collision_q. */
export function collisionQ(length, weight, bat) {
  const b = (length - 6) - bat.balance_frac * length;
  const iCm = weight * (bat.gyration_frac * length) ** 2;
  const mEff = 1 / (1 / weight + (b * b) / iCm);
  const r = bat.ball_oz / mEff;
  return (bat.cor - r) / (1 + r);
}

/** Readings separated by commas, spaces, tabs or new lines; keeps plausible exit velos. */
export function parseReadings(text) {
  return (text.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((v) => v >= 20 && v <= 130);
}

// Interpolate a per-sample-size calibration value on log(k), clamped to the calibrated range.
function atK(n, ks, vals) {
  const x = Math.log(Math.max(ks[0], Math.min(ks[ks.length - 1], n)));
  for (let i = 1; i < ks.length; i++) {
    const x0 = Math.log(ks[i - 1]), x1 = Math.log(ks[i]);
    if (x <= x1) return vals[i - 1] + (vals[i] - vals[i - 1]) * ((x - x0) / (x1 - x0));
  }
  return vals[vals.length - 1];
}

export function estimate({ evs, tee, pitch, length, weight }, meta) {
  const E = meta.estimator, B = meta.bat;
  const n = evs.length;
  if (n < 5) return { n, error: `Enter at least 5 readings (${n} so far).` };
  const sorted = [...evs].sort(d3.ascending);
  const ev90 = d3.quantile(sorted, 0.9);
  const plate = tee ? 0 : pitch * E.plate_factor;
  const q0 = E.q0, qh = collisionQ(length, weight, B);
  const bias = atK(n, E.k, E.bias);
  const pitchAdd = q0 * (E.ref_plate - plate);
  const fromEv90 = (v) => E.a + E.b * (v + pitchAdd - bias);
  // Put EV90 on the standard 34/32 bat at the same contact quality (needs a bat speed, so iterate).
  let bs = fromEv90(ev90), ev90std = ev90;
  for (let i = 0; i < 3; i++) {
    ev90std = ev90 * (q0 * plate + (1 + q0) * bs) / (qh * plate + (1 + qh) * bs);
    bs = fromEv90(ev90std);
  }
  const H = E.hitter_bs;
  return {
    n, ev90, max: sorted[sorted.length - 1], bs, bias, pitchAdd, batAdj: ev90std - ev90, qh,
    rmse: atK(n, E.k, E.rmse),
    lo80: bs + atK(n, E.k, E.lo80), hi80: bs + atK(n, E.k, E.hi80),
    lo95: bs + atK(n, E.k, E.lo95), hi95: bs + atK(n, E.k, E.hi95),
    pct: d3.bisectLeft(H, bs) / H.length, below: bs < H[0], above: bs > H[H.length - 1],
    extrapolated: tee || pitch < 70 || bs < H[0] - 2,
  };
}

function strip(container, res, meta) {
  const E = meta.estimator, H = E.hitter_bs;
  const small = container.clientWidth < 520;
  const m = { t: 34, r: 16, b: 34, l: 16 };
  const { g, w, h, svg } = frame(container, 120, m);
  svg.attr("aria-label", "Estimated bat speed and its range against MLB hitters' average bat speeds");
  const ok = res && !res.error;
  const lo = Math.min(H[0], ok ? res.lo95 : H[0]) - 1.5, hi = Math.max(H[H.length - 1], ok ? res.hi95 : H[0]) + 1.5;
  const x = d3.scaleLinear().domain([Math.floor(lo), Math.ceil(hi)]).range([0, w]);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(small ? 6 : 10).tickSizeOuter(0).tickFormat((v) => `${v}`));
  g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 30).attr("text-anchor", "end").text("Average bat speed (mph)");
  // MLB hitters: one thin tick each.
  g.append("g").selectAll("line").data(H).join("line")
    .attr("x1", (v) => x(v)).attr("x2", (v) => x(v)).attr("y1", h - 22).attr("y2", h - 4)
    .attr("stroke", cssVar("--muted")).attr("stroke-opacity", 0.35).attr("stroke-width", 1);
  const avg = d3.mean(H);
  g.append("text").attr("class", "axis-label").attr("x", x(avg)).attr("y", h - 26).attr("text-anchor", "middle")
    .style("text-transform", "none").text(`MLB avg ${fmt.f1(avg)}`);
  if (!ok) return;
  const pos = cssVar("--pos");
  g.append("rect").attr("x", x(res.lo95)).attr("width", x(res.hi95) - x(res.lo95)).attr("y", -14).attr("height", 14).attr("rx", 4)
    .attr("fill", pos).attr("fill-opacity", 0.14);
  g.append("rect").attr("x", x(res.lo80)).attr("width", x(res.hi80) - x(res.lo80)).attr("y", -14).attr("height", 14).attr("rx", 4)
    .attr("fill", pos).attr("fill-opacity", 0.32);
  g.append("line").attr("x1", x(res.bs)).attr("x2", x(res.bs)).attr("y1", -18).attr("y2", h - 2)
    .attr("stroke", pos).attr("stroke-width", 2).attr("stroke-linecap", "round");
  g.append("circle").attr("cx", x(res.bs)).attr("cy", -7).attr("r", 6).attr("fill", cssVar("--select-fill")).attr("stroke", cssVar("--select-ring")).attr("stroke-width", 2.5);
  if (res.actual != null) {
    g.append("path").attr("d", d3.symbol(d3.symbolTriangle, 70)()).attr("transform", `translate(${x(res.actual)},${h - 2}) rotate(180)`)
      .attr("fill", cssVar("--ink"));
  }
}

function readout(out, res, meta) {
  if (!res) { out.replaceChildren(el("p", { class: "empty" }, "Paste exit velo readings to get an estimate.")); return; }
  if (res.error) { out.replaceChildren(el("p", { class: "empty" }, res.error)); return; }
  const E = meta.estimator;
  const tighter = E.k.filter((k) => k > res.n).slice(0, 2).map((k) => `±${fmt.f1(atK(k, E.k, E.rmse))} at ${k}`);
  const standing = res.below ? `Slower than every ${E.hitter_season} MLB hitter with 150+ batted balls (slowest ${fmt.f1(E.hitter_bs[0])} mph).`
    : res.above ? `Faster than every ${E.hitter_season} MLB hitter with 150+ batted balls.`
      : `About the ${pctOrd(res.pct)} percentile of ${E.hitter_season} MLB hitters.`;
  const sign = (v) => (Math.abs(v) < 0.05 ? "±0.0" : fmt.s1(v));
  setKids(out,
    el("span", { class: "label" }, "Estimated average bat speed"),
    el("span", { class: "est-value" }, fmt.f1(res.bs), el("small", {}, "mph")),
    el("p", { class: "est-range" },
      el("b", {}, `${fmt.f1(res.lo80)}–${fmt.f1(res.hi80)} mph`), " likely range (80%)", el("br"),
      el("span", { class: "muted" }, `${fmt.f1(res.lo95)}–${fmt.f1(res.hi95)} mph at 95% · typical miss ±${fmt.f1(res.rmse)} mph with ${res.n} readings${tighter.length ? ` (${tighter.join(", ")})` : ""}`)),
    el("p", {}, standing),
    res.actual != null ? el("p", { class: "est-actual" }, el("b", {}, `Statcast measured ${fmt.f1(res.actual)} mph`), ` for ${res.actualName}: the estimate is off by ${fmt.s1(res.bs - res.actual)} mph.`) : null,
    el("table", { class: "board compact est-steps" }, el("tbody", {},
      el("tr", {}, el("td", { class: "l" }, `EV90 of your ${res.n} readings`), el("td", {}, `${fmt.f1(res.ev90)} mph`)),
      el("tr", {}, el("td", { class: "l" }, "Small-sample correction"), el("td", {}, `${sign(-res.bias)} mph`)),
      el("tr", {}, el("td", { class: "l" }, `Pitch speed, converted to an MLB pitch (${fmt.f0(E.ref_plate / E.plate_factor)} mph)`), el("td", {}, `${sign(res.pitchAdd)} mph`)),
      el("tr", {}, el("td", { class: "l" }, "Bat size, converted to a 34 in / 32 oz bat"), el("td", {}, `${sign(res.batAdj)} mph`)),
      el("tr", {}, el("td", { class: "l" }, `Bat speed = ${fmt.f2(E.a)} + ${d3.format(".3f")(E.b)} × adjusted EV90`), el("td", {}, el("b", {}, `${fmt.f1(res.bs)} mph`))))),
  );
}

export function initEstimator(meta, { getExample }) {
  const $ = (id) => document.getElementById(id);
  const evsEl = $("est-evs"), psEl = $("est-ps"), lenEl = $("est-len"), wtEl = $("est-wt");
  let tee = true, example = null;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (saved) { evsEl.value = saved.evs || ""; psEl.value = saved.ps || 55; lenEl.value = saved.len || 34; wtEl.value = saved.wt || 32; tee = saved.tee !== false; }
  } catch (e) { /* storage unavailable */ }

  const setMode = (isTee) => {
    tee = isTee;
    for (const b of $("est-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String((b.dataset.mode === "tee") === tee));
    psEl.disabled = tee;
  };
  const update = () => {
    const evs = parseReadings(evsEl.value);
    const length = +lenEl.value || 34, weight = +wtEl.value || 32;
    $("est-drop").textContent = `drop ${fmt.f1(weight - length)}`;
    $("est-parsed").textContent = evs.length ? `${evs.length} readings · max ${fmt.f1(d3.max(evs))} · avg ${fmt.f1(d3.mean(evs))} mph` : "";
    const res = evs.length ? estimate({ evs, tee, pitch: +psEl.value || 0, length, weight }, meta) : null;
    if (res && !res.error && example) { res.actual = example.actual; res.actualName = example.name; }
    readout($("est-output"), res, meta);
    strip($("est-strip"), res, meta);
    const notes = [
      "Estimates a hitter's average bat speed in Statcast terms (sweet spot, competitive swings), not their peak swing.",
      "Calibrated on MLB hitters with wood bats in games. Use readings from full, competitive swings and leave out bunts and check swings, but keep the mishits: the calibration expects them.",
    ];
    if (res && res.extrapolated) notes.push("Tee, slow pitches and bat speeds below the MLB range rely on the physics conversion rather than direct MLB evidence, so treat the range as a minimum.");
    notes.push("Bat material isn't modeled. BBCOR bats are regulated to perform close to wood; USSSA and other youth bats launch the ball faster, so estimates from them will read high.");
    setKids($("est-notes"), ...notes.map((t) => el("li", {}, t)));
    try { localStorage.setItem(STORE, JSON.stringify({ evs: evsEl.value, ps: psEl.value, len: lenEl.value, wt: wtEl.value, tee })); } catch (e) { /* storage unavailable */ }
  };
  let t;
  const soon = () => { clearTimeout(t); t = setTimeout(update, 120); };
  const userEdit = () => { example = null; soon(); };
  evsEl.addEventListener("input", userEdit);
  for (const elx of [psEl, lenEl, wtEl]) elx.addEventListener("input", userEdit);
  $("est-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; example = null; setMode(b.dataset.mode === "tee"); update(); });
  $("est-example").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const ex = await getExample(20);
      if (!ex) return;
      example = ex;
      evsEl.value = ex.evs.map((v) => fmt.f1(v)).join(", ");
      psEl.value = Math.round(ex.pitch);
      lenEl.value = ex.length; wtEl.value = ex.weight;
      setMode(false);
      update();
    } finally { btn.disabled = false; }
  });
  setMode(tee);
  update();
  return { redraw: update };
}
