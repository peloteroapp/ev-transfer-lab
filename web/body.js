/* Body size section: height, weight and weight/height ratio vs bat speed and exit velo. */
/* global d3 */
import { fmt, show, nil, linFit, feetInches } from "./lib.js";
import { renderTraits } from "./traits.js";

export const BODY_X = {
  ht: { label: "Height", lc: "height", axis: "Listed height (in)", f: feetInches, tick: feetInches, per: "inch", step: 1, jitter: 0.35 },
  wt: { label: "Weight", lc: "weight", axis: "Listed weight (lb)", f: (v) => `${fmt.f0(v)} lb`, per: "10 lb", step: 10, jitter: 1.5 },
  wtht: { label: "Weight ÷ height", lc: "weight ÷ height", axis: "Weight ÷ height (lb per inch; higher = more mass for the frame)", f: (v) => `${d3.format(".2f")(v)} lb/in`, tick: d3.format(".2f"), per: "0.1 lb/in", step: 0.1 },
};
export const BODY_Y = {
  bs: { label: "Bat speed", lc: "bat speed", axis: "Avg bat speed (mph)", f: fmt.f1, unit: "mph" },
  ev: { label: "Avg exit velo", lc: "avg exit velo", axis: "Avg exit velo (mph)", f: fmt.f1, unit: "mph" },
  ev90: { label: "EV90", lc: "EV90", axis: "EV90, 90th pct exit velo (mph)", f: fmt.f1, unit: "mph" },
  evoe: { label: "EV over expected", lc: "EV over expected", axis: "EV over expected (mph)", f: fmt.s1, unit: "mph" },
};

/** Plain-language read of the matrix for the current filters. */
function takeaway(r) {
  const best = (y) => d3.greatest(Object.keys(BODY_X), (x) => Math.abs(r(x, y)));
  const bsX = best("bs"), evoeX = best("evoe");
  if (Number.isNaN(r(bsX, "bs"))) return "Not enough hitters in this filter to correlate.";
  const ratio = r("wtht", "bs");
  const ht = r("ht", "bs"), wt = r("wt", "bs");
  const lead = Math.abs(ht - wt) < 0.03
    ? `Height and weight track bat speed about equally (r ${fmt.f2(ht)} and ${fmt.f2(wt)}; each explains about ${fmt.pct(Math.max(ht, wt) ** 2)} of the spread).`
    : `${BODY_X[bsX].label} tracks bat speed most closely (r ${fmt.f2(r(bsX, "bs"))}, explaining ${fmt.pct(r(bsX, "bs") ** 2)} of the spread).`;
  return [
    lead,
    ratio >= 0
      ? ` Weight ÷ height shows the same pattern (r ${fmt.f2(ratio)}): more mass per inch goes with more bat speed.`
      : ` Weight ÷ height runs the other way (r ${fmt.f2(ratio)}): leaner frames go with more bat speed.`,
    ` Against EV over expected, body size explains little (best: ${BODY_X[evoeX].lc}, r ${fmt.f2(r(evoeX, "evoe"))}). Size mostly buys speed, not better transfer.`,
  ].join("");
}

const BODY_CFG = {
  X: BODY_X,
  Y: BODY_Y,
  takeaway,
  tooltip: (p) => [
    ["Height · weight", `${feetInches(p.ht)} · ${show(p.wt, fmt.f0)} lb`],
    ["Weight ÷ height", `${d3.format(".2f")(p.wtht)} lb/in`],
  ],
  outlierCopy: (X, Y) => ({
    overTitle: `More ${Y.lc} than ${X.lc} predicts`,
    overSub: "Over-performers for their size: where to look for movement that creates speed or exit velo beyond the frame.",
    underTitle: `Less ${Y.lc} than ${X.lc} predicts`,
    underSub: "Under-performers: the size is there, the output isn't.",
  }),
};

export function renderBody(els, rows, state, handlers) {
  renderTraits(els, rows, BODY_CFG, { xKey: state.bodyX, yKey: state.bodyY, selectedId: state.player }, handlers);
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
