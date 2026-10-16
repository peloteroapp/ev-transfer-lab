/* Player panel: swing-level view, swings to watch, path vs same-speed peers, comps. */
/* global d3 */
import { fmt, show, nil, el, watchButton, pctOrd, PITCH_NAMES } from "./lib.js";
import { swingScatter, peerStrip } from "./charts.js";

const PEER_BAND = 1.5; // mph of average bat speed either side
const COMP_BAND = 1.0;

const PATH_ROWS = [
  { key: "lb_aa", label: "Attack angle", unit: "°", f: fmt.f1, src: "all swings" },
  { key: "lb_ideal", label: "Ideal attack angle rate", unit: "", f: fmt.pct, src: "all swings" },
  { key: "lb_ad", label: "Attack direction (− pull)", unit: "°", f: fmt.f1, src: "all swings" },
  { key: "lb_tilt", label: "Swing path tilt", unit: "°", f: fmt.f1, src: "all swings" },
  { key: "lb_iy", label: "Contact depth (in front of body)", unit: " in", f: fmt.f1, src: "all swings" },
  { key: "ix", label: "Reach (contact distance from body)", unit: " in", f: fmt.f1, src: "batted balls" },
  { key: "plane", label: "Plane match (AA + pitch descent)", unit: "°", f: fmt.f1, src: "batted balls" },
  { key: "gap_v", label: "Vertical face-to-path miss", unit: "°", f: fmt.f1, src: "batted balls" },
  { key: "gap_h", label: "Horizontal face-to-path miss", unit: "°", f: fmt.f1, src: "batted balls" },
  { key: "lb_len", label: "Swing length", unit: " ft", f: fmt.f1, src: "all swings" },
];

export function swingsFromRecord(rec, season) {
  if (!rec) return [];
  const n = rec.bs.length, out = [];
  for (let i = 0; i < n; i++) {
    if (season && rec.season[i] !== season) continue;
    const s = {};
    for (const k in rec) s[k] = rec[k][i];
    out.push(s);
  }
  return out;
}

function tile(label, value, unit, ctx) {
  return el("div", { class: "tile" },
    el("span", { class: "label" }, label),
    el("span", { class: "value" }, value, unit ? el("small", {}, unit) : null),
    ctx ? el("span", { class: "ctx" }, ctx) : null);
}

function swingTable(swings, { compact = false } = {}) {
  if (!swings.length) return el("p", { class: "empty" }, "No batted balls in this view.");
  const head = ["", "Date", "Pitch", "Bat spd", "EV", "vs exp", "EV pct", "LA", "AA", "Dir", "Result"];
  return el("div", { class: "table-wrap" }, el("table", { class: "board compact" },
    el("thead", {}, el("tr", {}, head.map((hd, i) => el("th", { class: i < 3 ? "l" : null }, hd)))),
    el("tbody", {}, swings.map((s) => el("tr", {},
      el("td", { class: "l" }, watchButton(s)),
      el("td", { class: "l" }, compact ? s.date.slice(5) : s.date),
      el("td", { class: "l" }, `${s.pt || "–"} ${show(s.ps, fmt.f0)}`),
      el("td", {}, fmt.f1(s.bs)),
      el("td", {}, fmt.f1(s.ev)),
      el("td", {}, fmt.s1(s.r)),
      el("td", {}, nil(s.cp) ? "–" : pctOrd(s.cp / 100)),
      el("td", {}, show(s.la, fmt.f0)),
      el("td", {}, show(s.aa, fmt.f0)),
      el("td", {}, show(s.ad, fmt.f0)),
      el("td", {}, s.res),
    )))));
}

/** Nearest comp swing to each of the main hitter's best-transfer swings. */
function matchSwings(best, compSwings) {
  const pairs = [];
  for (const a of best) {
    let pick = null, score = Infinity;
    for (const b of compSwings) {
      const dbs = Math.abs(a.bs - b.bs);
      if (dbs > 1.5) continue;
      const loc = nil(a.px) || nil(b.px) ? 1 : Math.hypot(a.px - b.px, a.pz - b.pz);
      const sc = dbs + loc / 0.4 + Math.abs((a.ps || 0) - (b.ps || 0)) / 4 + (a.pg === b.pg ? 0 : 3);
      if (sc < score) { score = sc; pick = b; }
    }
    if (pick) pairs.push([a, pick]);
  }
  return pairs;
}

export function renderPlayer(section, ctx) {
  const { player, comp, peersAll, swings, compSwings, meta, season, onSelect, onComp, onClose, minN } = ctx;
  section.hidden = false;
  section.replaceChildren();
  const curves = meta.curves[season], density = meta.density[season];
  const seasonLabel = season ? String(season) : "All seasons";

  // Same-speed peers (same season, min batted balls), excluding the hitter.
  const peers = peersAll.filter((h) => h.id !== player.id && Math.abs(h.bs - player.bs) <= PEER_BAND);
  const peerVals = peers.map((h) => h.evoe);
  const rank = peerVals.length ? (peerVals.filter((v) => v < player.evoe).length + 0.5 * peerVals.filter((v) => v === player.evoe).length) / peerVals.length : null;
  const bsRank = peersAll.length ? peersAll.filter((h) => h.bs < player.bs).length / peersAll.length : null;

  // ---- head
  const close = el("button", { class: "btn secondary sm", type: "button", onclick: onClose }, "Close");
  const compSel = el("select", { "aria-label": "Compare with a same-speed hitter", onchange: (e) => onComp(e.target.value ? +e.target.value : null) },
    el("option", { value: "" }, "Compare with…"),
    [...peersAll].filter((h) => h.id !== player.id).sort((a, b) => Math.abs(a.bs - player.bs) - Math.abs(b.bs - player.bs)).slice(0, 60)
      .sort((a, b) => b.evoe - a.evoe)
      .map((h) => el("option", { value: h.id, selected: comp && comp.id === h.id ? true : null }, `${h.name} · ${fmt.f1(h.bs)} mph · ${fmt.s1(h.evoe)}`)));
  section.append(el("div", { class: "player-head" },
    el("div", {},
      el("h2", { id: "player-name" }, player.name),
      el("div", { class: "tags" },
        el("span", { class: "tag accent" }, seasonLabel),
        el("span", { class: "tag" }, player.team),
        el("span", { class: "tag" }, `Bats ${player.bats}`),
        el("span", { class: "tag" }, `${fmt.int(player.n)} batted balls`),
        el("span", { class: "tag", title: player.bat_src === "assumed" ? "Not in data/bat_specs.csv" : `Source: ${player.bat_src}` },
          `Bat ${fmt.f0(player.bat_len)} in / ${fmt.f0(player.bat_oz)} oz${player.bat_src === "assumed" ? " (assumed)" : ""}`),
        comp ? el("span", { class: "tag comp" }, `vs ${comp.name}`) : null)),
    el("div", { class: "range-pair" }, compSel, close)));

  // ---- tiles
  section.append(el("div", { class: "player-tiles" },
    tile("Avg bat speed", fmt.f1(player.bs), "mph", bsRank === null ? null : `${pctOrd(bsRank)} pct of hitters`),
    tile("Avg exit velo", fmt.f1(player.ev), "mph", `Expected ${fmt.f1(player.xev)} from these swings`),
    tile("EV over expected", fmt.s1(player.evoe), "mph", rank === null ? "No same-speed peers" : `${pctOrd(rank)} pct of ${peers.length} same-speed peers`),
    tile("Bat-adjusted", fmt.s1(player.evoe_bat), "mph", player.bat_src === "assumed"
      ? `No bat specs listed; assumes ${fmt.f0(player.bat_len)} in / ${fmt.f0(player.bat_oz)} oz`
      : `EV over expected minus ${fmt.f1(Math.abs(player.bat_adj))} mph estimated for a ${fmt.f0(player.bat_len)}/${fmt.f0(player.bat_oz)} bat`),
    tile("EV90 over expected", show(player.top, fmt.s1), "mph", `EV90 ${fmt.f1(player.ev90)} mph`),
    tile("Squared-up (BIP)", fmt.pct(player.sq), "", `League ${fmt.pct(meta.league[season].sq)}`)));

  // ---- swing chart + swings to watch
  const grid = el("div", { class: "player-grid" });
  const left = el("div", {});
  const right = el("div", {});
  grid.append(left, right);
  section.append(grid);

  left.append(el("h3", { style: "margin-top:8px" }, "Every batted ball vs the league"),
    el("p", { class: "sub" }, "Dots above the median line got more EV than usual for that bat speed. Click a dot for its video."));
  const chart = el("div", { class: "chart" });
  const legend = el("div", { class: "legend" });
  const detail = el("div", {});
  left.append(chart, legend, detail);

  let picked = null;
  const names = { main: player.name, comp: comp ? comp.name : "" };
  const draw = () => swingScatter(chart, legend, { swings, comp: compSwings, curves, density, selected: picked, onPick, names });
  const onPick = (s) => {
    picked = s;
    draw();
    const who = s.who === "comp" ? comp.name : player.name;
    detail.replaceChildren(el("div", { class: "swing-detail" },
      el("span", {}, el("b", {}, who), ` · ${s.date}`),
      el("span", {}, `${PITCH_NAMES[s.pt] || s.pt || "–"} ${show(s.ps, fmt.f1)} mph`),
      el("span", {}, "Bat ", el("b", {}, fmt.f1(s.bs))),
      el("span", {}, "EV ", el("b", {}, fmt.f1(s.ev)), ` (${fmt.s1(s.r)} vs exp)`),
      el("span", {}, `LA ${show(s.la, fmt.f0)}° · AA ${show(s.aa, fmt.f0)}° · Dir ${show(s.ad, fmt.f0)}° · Tilt ${show(s.tilt, fmt.f0)}°`),
      el("span", {}, `Contact ${show(s.iy, fmt.f0)} in front, ${show(s.ix, fmt.f0)} in out`),
      el("span", {}, s.res),
      watchButton(s, "Watch swing")));
  };
  draw();

  // Swings to watch: typical bat speed band (player's middle 50%) so speed is held constant.
  const sorted = [...swings].map((s) => s.bs).sort(d3.ascending);
  const q1 = d3.quantileSorted(sorted, 0.25), q3 = d3.quantileSorted(sorted, 0.75);
  const typical = swings.filter((s) => s.bs >= q1 && s.bs <= q3);
  const lists = {
    best: [...typical].sort((a, b) => b.r - a.r).slice(0, 12),
    worst: [...typical].sort((a, b) => a.r - b.r).slice(0, 12),
    recent: [...swings].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40),
  };
  right.append(el("h3", { style: "margin-top:8px" }, "Swings to watch"),
    el("p", { class: "sub" }, `Held to this hitter's typical bat speed (${show(q1, fmt.f1)}–${show(q3, fmt.f1)} mph), so the difference is the swing, not the speed.`));
  const tabsEl = el("div", { class: "seg tabs", role: "group", "aria-label": "Swing list" });
  const listEl = el("div", {});
  const tabDefs = [["best", "Best transfer"], ["worst", "Mishits"], ["recent", "Recent"]];
  const setTab = (k) => {
    tabsEl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === k)));
    listEl.replaceChildren(swingTable(lists[k], { compact: true }));
  };
  tabDefs.forEach(([k, lab]) => tabsEl.append(el("button", { type: "button", "data-k": k, "aria-pressed": "false", onclick: () => setTab(k) }, lab)));
  right.append(tabsEl, listEl);
  setTab("best");

  // ---- matched swings (compare mode)
  if (comp && compSwings) {
    const holder = el("div", {});
    const mode = el("div", { class: "seg tabs", role: "group", "aria-label": "Pair with" });
    // The comp's own best contact: their top 30% of batted balls by EV vs expected.
    const cut = d3.quantile(compSwings.map((s) => s.r).sort(d3.ascending), 0.7);
    const pools = { any: compSwings, hard: compSwings.filter((s) => s.r >= cut) };
    const blurbs = {
      any: `${player.name}'s best-transfer swings, each paired with ${comp.name}'s closest swing on bat speed, pitch type, pitch speed and location. Same inputs, different exit velo.`,
      hard: `Same pairing, but only against ${comp.name}'s own best contact (their top 30% vs expected). Isolates top-end transfer from mishits.`,
    };
    const blurb = el("p", { class: "sub" });
    const drawPairs = (k) => {
      mode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === k)));
      blurb.textContent = blurbs[k];
      const pairs = matchSwings(lists.best.slice(0, 10), pools[k]);
      if (!pairs.length) { holder.replaceChildren(el("p", { class: "empty" }, "No swings within 1.5 mph of each other.")); return; }
      const side = ["Bat spd", "Pitch", "EV", "LA", "AA", "Dir", ""];
      holder.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "board compact" },
        el("thead", {},
          el("tr", {},
            el("th", { class: "l", colspan: 7, style: "color:var(--ink)" }, el("span", { class: "swatch-dot", style: "display:inline-block;margin-right:6px;background:var(--pos)" }), player.name),
            el("th", { class: "l", colspan: 7, style: "color:var(--ink)" }, el("span", { class: "swatch-dot", style: "display:inline-block;margin-right:6px;background:var(--neg)" }), comp.name),
            el("th", {}, "")),
          el("tr", {}, [...side, ...side, "ΔEV"].map((hd, i) => el("th", { class: i === 1 || i === 8 ? "l" : null }, hd)))),
        el("tbody", {}, pairs.map(([a, b]) => el("tr", {},
          el("td", {}, fmt.f1(a.bs)), el("td", { class: "l" }, `${a.pt} ${show(a.ps, fmt.f0)}`), el("td", {}, fmt.f1(a.ev)),
          el("td", {}, show(a.la, fmt.f0)), el("td", {}, show(a.aa, fmt.f0)), el("td", {}, show(a.ad, fmt.f0)), el("td", {}, watchButton(a)),
          el("td", {}, fmt.f1(b.bs)), el("td", { class: "l" }, `${b.pt} ${show(b.ps, fmt.f0)}`), el("td", {}, fmt.f1(b.ev)),
          el("td", {}, show(b.la, fmt.f0)), el("td", {}, show(b.aa, fmt.f0)), el("td", {}, show(b.ad, fmt.f0)), el("td", {}, watchButton(b)),
          el("td", {}, el("b", {}, fmt.s1(a.ev - b.ev)))))))));
    };
    [["any", "Closest swing"], ["hard", "Closest hard contact"]].forEach(([k, lab]) =>
      mode.append(el("button", { type: "button", "data-k": k, "aria-pressed": "false", onclick: () => drawPairs(k) }, lab)));
    section.append(el("h3", {}, `Matched swings: ${player.name} vs ${comp.name}`), blurb, mode, holder);
    drawPairs("any");
  }

  // ---- swing path vs same-speed peers
  const efficient = [...peers].sort((a, b) => b.evoe - a.evoe).slice(0, Math.max(1, Math.round(peers.length / 4)));
  section.append(el("h3", {}, "Swing path vs same-speed peers"),
    el("p", { class: "sub" }, `${peers.length} hitters within ±${PEER_BAND} mph of ${player.name}'s average bat speed. Blue ticks = the top quarter of them by EV over expected (triangle = their average).`));
  const strips = el("div", {});
  section.append(strips);
  const stripCharts = [];
  for (const row of PATH_ROWS) {
    const pv = peers.map((h) => h[row.key]).filter((v) => !nil(v));
    if (nil(player[row.key]) && !pv.length) continue;
    const ev = efficient.map((h) => h[row.key]).filter((v) => !nil(v));
    const holder = el("div", { class: "chart" });
    const em = ev.length ? d3.mean(ev) : null;
    strips.append(el("div", { class: "strip-row" },
      el("span", { class: "nm", title: `Source: ${row.src}` }, row.label,
        el("br"), el("span", { class: "muted", style: "font-size:12px" }, em === null ? "" : `Top-quarter avg ${row.f(em)}${row.unit}`)),
      holder,
      el("span", { class: "v" }, nil(player[row.key]) ? "–" : `${row.f(player[row.key])}${row.unit}`)));
    stripCharts.push(() => peerStrip(holder, { peers: pv, efficient: ev, value: player[row.key], compValue: comp ? comp[row.key] : null }));
  }
  strips.append(el("div", { class: "legend" },
    el("span", { class: "key" }, el("span", { class: "swatch-dot", style: "background:var(--select-fill);outline:2px solid var(--select-ring)" }), player.name),
    comp ? el("span", { class: "key" }, el("span", { class: "swatch-dot", style: "border:2.5px solid var(--neg)" }), comp.name) : null,
    el("span", { class: "key" }, el("span", { class: "swatch-line", style: "width:2px;height:14px;background:var(--pos)" }), "Top-quarter EV over expected peer"),
    el("span", { class: "key" }, el("span", { class: "swatch-line", style: "width:1px;height:10px;background:var(--muted)" }), "Other same-speed peer")));
  stripCharts.forEach((f) => f());

  // ---- same-speed comps
  const near = peersAll.filter((h) => h.id !== player.id && Math.abs(h.bs - player.bs) <= COMP_BAND).sort((a, b) => b.evoe - a.evoe);
  const compRow = (h) => el("div", { class: "comp-row" },
    el("a", { href: "#", class: "nm", onclick: (e) => { e.preventDefault(); onSelect(h.id); } }, h.name),
    el("span", { class: "v" }, `${fmt.f1(h.bs)} mph`),
    el("b", {}, `${fmt.s1(h.evoe)} mph`),
    el("button", { class: "watch", type: "button", onclick: () => onComp(h.id) }, comp && comp.id === h.id ? "Comparing" : "Compare"));
  const compList = (title, list, empty) => el("div", {}, el("h4", {}, title),
    list.length ? list.map(compRow) : el("p", { class: "empty" }, empty));
  section.append(el("h3", {}, "Same-speed comps"),
    el("p", { class: "sub" }, `Hitters within ±${COMP_BAND} mph of ${fmt.f1(player.bs)} mph average bat speed, ${seasonLabel}, ${minN}+ batted balls. Compare overlays their swings and pairs matching swings for video.`),
    el("div", { class: "comps" },
      compList("More EV from the same speed", near.filter((h) => h.evoe > player.evoe).slice(0, 6), `${player.name} leads this bat speed group.`),
      compList("Less EV from the same speed", near.filter((h) => h.evoe < player.evoe).reverse().slice(0, 6), `${player.name} trails this bat speed group.`)));
}
