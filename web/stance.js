/* Batting stance section: Savant's Hawk-Eye stance (1 s before release) vs bat speed and EV over expected. */
/* global d3 */
import { fmt, nil, feetInches } from "./lib.js";
import { renderTraits, corr, partialCorr } from "./traits.js";

export const angle = (v) => (nil(v) ? "–" : `${fmt.f0(Math.abs(v))}° ${v < -0.5 ? "open" : v > 0.5 ? "closed" : "square"}`);

export const STANCE_X = {
  st_depth: {
    label: "Depth in box", lc: "depth in the box", axis: "Depth in box (in behind the front of the plate; higher = deeper)",
    f: (v) => `${fmt.f1(v)} in`, per: "inch", step: 1, hi: "Deepest in the box", lo: "Farthest up in the box",
  },
  st_off: {
    label: "Off the plate", lc: "distance off the plate", axis: "Distance off the plate (in from the inside edge)",
    f: (v) => `${fmt.f1(v)} in`, per: "inch", step: 1, hi: "Farthest off the plate", lo: "Closest to the plate",
  },
  st_feet: {
    label: "Foot separation", lc: "foot separation", axis: "Distance between the feet (in)",
    f: (v) => `${fmt.f1(v)} in`, per: "inch", step: 1, hi: "Widest stances", lo: "Narrowest stances",
  },
  st_angle: {
    label: "Stance angle", lc: "stance angle", axis: "Stance angle (°; negative = open, positive = closed)",
    f: angle, tick: (v) => `${v}°`, per: "10°", step: 10, hi: "Most closed stances", lo: "Most open stances",
  },
};
export const STANCE_Y = {
  bs: { label: "Bat speed", lc: "bat speed", axis: "Avg bat speed (mph)", f: fmt.f1, unit: "mph" },
  evoe: { label: "EV over expected", lc: "EV over expected", axis: "EV over expected (mph)", f: fmt.s1, unit: "mph" },
};

function takeaway(r, rows) {
  const keys = Object.keys(STANCE_X);
  const best = (y) => d3.greatest(keys, (x) => Math.abs(r(x, y)));
  const bsX = best("bs"), evoeX = best("evoe");
  if (Number.isNaN(r(bsX, "bs"))) return "Not enough hitters in this filter to correlate.";
  const weak = (v) => Math.abs(v) < 0.1;
  const parts = [];
  parts.push(weak(r(bsX, "bs"))
    ? `No stance measure tracks bat speed in a meaningful way here (strongest: ${STANCE_X[bsX].lc}, r ${fmt.f2(r(bsX, "bs"))}).`
    : `${STANCE_X[bsX].label} tracks bat speed most closely (r ${fmt.f2(r(bsX, "bs"))}).`);
  // Is that just size? Taller hitters stand differently, and taller hitters swing faster.
  const withHt = corr(rows, bsX, "ht").r;
  const net = partialCorr(rows, bsX, "bs", "ht");
  if (!weak(r(bsX, "bs")) && !Number.isNaN(net)) {
    parts.push(` Part of that is size: it runs with height (r ${fmt.f2(withHt)}), and at the same height it drops to r ${fmt.f2(net)}.`);
  }
  parts.push(weak(r(evoeX, "evoe"))
    ? ` None of the four relate to EV over expected (strongest |r| ${fmt.f2(Math.abs(r(evoeX, "evoe")))}): how a hitter sets up doesn't predict how well they transfer speed into the ball.`
    : ` ${STANCE_X[evoeX].label} relates most to EV over expected (r ${fmt.f2(r(evoeX, "evoe"))}).`);
  return parts.join("");
}

const STANCE_CFG = {
  X: STANCE_X,
  Y: STANCE_Y,
  takeaway,
  tooltip: (p) => [
    ["Depth · off plate", `${fmt.f1(p.st_depth)} in · ${fmt.f1(p.st_off)} in`],
    ["Feet apart · angle", `${fmt.f1(p.st_feet)} in · ${angle(p.st_angle)}`],
    ["Height", feetInches(p.ht)],
  ],
  outlierCopy: (X, Y) => ({
    overTitle: `More ${Y.lc} than ${X.lc} predicts`,
    overSub: "Hitters well above the line for their setup.",
    underTitle: `Less ${Y.lc} than ${X.lc} predicts`,
    underSub: "Hitters well below the line for their setup.",
  }),
};

export function renderStance(els, rows, state, handlers) {
  renderTraits(els, rows, STANCE_CFG, { xKey: state.stanceX, yKey: state.stanceY, selectedId: state.player }, handlers);
}
