/* EV Transfer Lab — state, filters, and page assembly. */
/* global d3 */
import { fmt, show, nil, el, ratingWash, divergingScale, cssVar, feetInches } from "./lib.js";
import { hitterScatter, driverMultiples, contactMap, correlationBars } from "./charts.js";
import { renderPlayer, swingsFromRecord } from "./player.js";
import { renderBody, sizeResiduals, BODY_X, BODY_Y } from "./body.js";

const $ = (id) => document.getElementById(id);
const PEER_BAND = 1.5;
const BOARD_LIMIT = 50;

const state = {
  season: null, min: 100, bsMin: null, bsMax: null, bats: "all",
  y: "ev", cols: "output", player: null, comp: null, all: false,
  sort: { key: "evoe", dir: -1 }, driversView: "chart", bodyX: "ht", bodyY: "bs",
};

let META, HITTERS, DRIVERS;
const shardCache = new Map();

/* ------------------------------------------------------------------ url state */
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const num = (k) => (p.has(k) && p.get(k) !== "" && !Number.isNaN(+p.get(k)) ? +p.get(k) : null);
  if (num("season") !== null) state.season = num("season");
  if (num("min") !== null) state.min = num("min");
  state.bsMin = num("bsmin");
  state.bsMax = num("bsmax");
  if (p.get("bats")) state.bats = p.get("bats");
  if (p.get("y")) state.y = p.get("y");
  if (p.get("cols")) state.cols = p.get("cols");
  state.player = num("player");
  state.comp = num("comp");
  state.bodyX = BODY_X[p.get("bx")] ? p.get("bx") : "ht";
  state.bodyY = BODY_Y[p.get("by")] ? p.get("by") : "bs";
}
function writeHash() {
  const p = new URLSearchParams();
  p.set("season", state.season);
  p.set("min", state.min);
  if (state.bsMin !== null) p.set("bsmin", state.bsMin);
  if (state.bsMax !== null) p.set("bsmax", state.bsMax);
  if (state.bats !== "all") p.set("bats", state.bats);
  if (state.y !== "ev") p.set("y", state.y);
  if (state.cols !== "output") p.set("cols", state.cols);
  if (state.player) p.set("player", state.player);
  if (state.comp) p.set("comp", state.comp);
  if (state.bodyX !== "ht") p.set("bx", state.bodyX);
  if (state.bodyY !== "bs") p.set("by", state.bodyY);
  history.replaceState(null, "", `#${p}`);
}

/* ------------------------------------------------------------------ data */
async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
function shardFor(id) {
  const k = String(id % META.shards).padStart(2, "0");
  if (!shardCache.has(k)) shardCache.set(k, loadJSON(`data/bip/${k}.json`));
  return shardCache.get(k);
}
async function swingsOf(id) {
  const shard = await shardFor(id);
  return swingsFromRecord(shard[String(id)], state.season);
}

/** Hitters for the season + min batted balls (the peer pool), with peer percentiles. */
function seasonPool() {
  const pool = HITTERS.filter((h) => h.season === state.season && h.n >= state.min);
  const byBs = [...pool].sort((a, b) => a.bs - b.bs);
  for (const h of pool) {
    let lo = d3.bisector((d) => d.bs).left(byBs, h.bs - PEER_BAND);
    let below = 0, ties = 0, n = 0;
    for (; lo < byBs.length && byBs[lo].bs <= h.bs + PEER_BAND; lo++) {
      const p = byBs[lo];
      if (p.id === h.id) continue;
      n++;
      if (p.evoe < h.evoe) below++;
      else if (p.evoe === h.evoe) ties++;
    }
    h.peerPct = n >= 3 ? (below + ties / 2) / n : null;
    h.peerN = n;
  }
  sizeResiduals(pool);
  return pool;
}
function filtered(pool) {
  return pool.filter((h) =>
    (state.bats === "all" || h.bats === state.bats) &&
    (state.bsMin === null || h.bs >= state.bsMin) &&
    (state.bsMax === null || h.bs <= state.bsMax));
}

/* ------------------------------------------------------------------ hero tiles */
function renderTiles() {
  const L = META.league[state.season];
  const split = META.stability.split.resid;
  const yoy = META.stability.yoy.evoe_raw;
  const tiles = [
    { cls: "tile accent", label: "Bat speed vs exit velo, hitter level", value: `r ${fmt.f2(L.r_hitter)}`,
      ctx: `Bat speed explains ${fmt.pct(L.r_hitter ** 2)} of the gap in hitters' average exit velo. The other ${fmt.pct(1 - L.r_hitter ** 2)} is what you're hunting.` },
    { label: "EV per 1 mph of bat speed", value: fmt.s2(L.slope_hitter), unit: "mph",
      ctx: `Across ${L.n_hitter_stats} hitters with ${META.minBbeStats}+ batted balls, each extra mph of average bat speed comes with about ${fmt.f1(L.slope_hitter)} mph of average EV.` },
    { label: "Swing-to-swing EV explained by speed", value: fmt.pct(L.r2_swing),
      ctx: `On a single batted ball, bat speed and pitch speed explain only ${fmt.pct(L.r2_swing)} of exit velo. Contact quality decides the rest (±${fmt.f0(L.resid_sd)} mph typical miss).` },
    { label: "EV over expected is a skill", value: fmt.f2(split.r_full),
      ctx: `Split-half reliability inside a season (${split.n} hitter-seasons). Season to next season: r ${fmt.f2(yoy.r)}. Bat speed itself: ${fmt.f2(META.stability.split.bs.r_full)}.` },
  ];
  $("hero-tiles").replaceChildren(...tiles.map((t) => el("div", { class: t.cls || "tile" },
    el("span", { class: "label" }, t.label),
    el("span", { class: "value" }, t.value, t.unit ? el("small", {}, t.unit) : null),
    el("span", { class: "ctx" }, t.ctx))));
  const note = $("season-note");
  note.hidden = !L.partial;
  note.textContent = L.partial ? `${state.season}: ${L.partial}. Samples are smaller; lean on the min batted balls filter.` : "";
}

/* ------------------------------------------------------------------ board */
const COLS = {
  output: [
    { key: "n", label: "BBE", f: fmt.int, title: "Competitive batted balls" },
    { key: "bs", label: "Bat spd", f: fmt.f1, title: "Average bat speed on competitive batted balls (mph)" },
    { key: "ev", label: "Avg EV", f: fmt.f1 },
    { key: "xev", label: "xEV", f: fmt.f1, title: "Expected average EV from these bat speeds and pitch speeds" },
    { key: "evoe", label: "EV over exp", f: null, title: "Average exit velo above what the league gets from the same bat speed and pitch speed (mph, shrunk for sample size)" },
    { key: "evoe_bat", label: "Bat-adj", f: fmt.s1, title: "EV over expected after removing the estimated effect of the hitter's bat vs a 34 in / 32 oz standard (data/bat_specs.csv). Hitters without listed specs are assumed standard, so their value matches EV over exp." },
    { key: "peerPct", label: "Peer pct", f: null, title: `Percentile of EV over expected among hitters within ±${PEER_BAND} mph average bat speed` },
    { key: "ev90", label: "EV90", f: fmt.f1, title: "90th percentile exit velo" },
    { key: "top", label: "EV90 over exp", f: fmt.s1, title: "EV90 above hitters with the same average bat speed (mph, shrunk)" },
    { key: "sq", label: "Sq-up", f: fmt.pct, title: "Share of batted balls with 80%+ of max possible EV (1.23×bat speed + 0.23×pitch speed)" },
    { key: "hh", label: "Hard-hit", f: fmt.pct, title: "Share of batted balls 95+ mph" },
  ],
  path: [
    { key: "n", label: "BBE", f: fmt.int },
    { key: "bs", label: "Bat spd", f: fmt.f1 },
    { key: "evoe", label: "EV over exp", f: null },
    { key: "lb_aa", label: "Attack ∠", f: fmt.f1, title: "Attack angle, all competitive swings (°)" },
    { key: "lb_ideal", label: "Ideal AA", f: fmt.pct, title: "Share of swings with a 5–20° attack angle" },
    { key: "lb_ad", label: "Attack dir", f: fmt.f1, title: "Attack direction, all swings (°, negative = pull)" },
    { key: "lb_tilt", label: "Tilt", f: fmt.f1, title: "Swing path tilt (°)" },
    { key: "lb_iy", label: "Depth", f: fmt.f1, title: "Contact point in front of the batter's body (in)" },
    { key: "ix", label: "Reach", f: fmt.f1, title: "Contact distance from the body, batted balls (in)" },
    { key: "plane", label: "Plane", f: fmt.f1, title: "Attack angle + pitch descent angle (°). 0 = bat on the pitch's plane" },
    { key: "gap_v", label: "V miss", f: fmt.f1, title: "Median |launch angle − attack angle| (°)" },
    { key: "gap_h", label: "H miss", f: fmt.f1, title: "Median |spray angle − attack direction| (°)" },
    { key: "lb_len", label: "Length", f: fmt.f1, title: "Swing length (ft)" },
  ],
  body: [
    { key: "n", label: "BBE", f: fmt.int },
    { key: "ht", label: "Height", f: feetInches, title: "Listed height" },
    { key: "wt", label: "Weight", f: fmt.f0, title: "Listed weight (lb)" },
    { key: "htwt", label: "Ht ÷ Wt", f: d3.format(".3f"), title: "Height (in) ÷ weight (lb). Lower = more mass for the frame" },
    { key: "bs", label: "Bat spd", f: fmt.f1 },
    { key: "bs_vs_size", label: "Spd vs size", f: fmt.s1, title: "Bat speed minus what height and weight together predict (mph), fit across hitters in this season and min batted balls" },
    { key: "ev", label: "Avg EV", f: fmt.f1 },
    { key: "ev_vs_size", label: "EV vs size", f: fmt.s1, title: "Average exit velo minus what height and weight together predict (mph)" },
    { key: "evoe", label: "EV over exp", f: null },
  ],
};

function evoeCell(v, scale, lim) {
  const pct = Math.min(1, Math.abs(v) / lim) * 50;
  return el("span", { class: "diverge" },
    el("span", {}, fmt.s1(v)),
    el("span", { class: "bar" }, el("span", {
      class: "fill",
      style: `background:${scale(v)};${v >= 0 ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%`}`,
    })));
}

function renderBoard(rows) {
  const cols = COLS[state.cols];
  const { key, dir } = state.sort;
  const sorted = [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (nil(va) && nil(vb)) return 0;
    if (nil(va)) return 1;
    if (nil(vb)) return -1;
    return typeof va === "string" ? dir * va.localeCompare(vb) : dir * (va - vb);
  });
  const shown = state.all ? sorted : sorted.slice(0, BOARD_LIMIT);
  const lim = 4, scale = divergingScale(3);
  const th = (c) => el("th", {
    title: c.title || null, scope: "col", tabindex: "0",
    "aria-sort": key === c.key ? (dir < 0 ? "descending" : "ascending") : null,
    onclick: () => sortBy(c.key), onkeydown: (e) => { if (e.key === "Enter") sortBy(c.key); },
  }, c.label);
  const table = $("board");
  table.replaceChildren(
    el("thead", {}, el("tr", {},
      el("th", { class: "l rank", scope: "col" }, "#"),
      el("th", { class: "l", scope: "col", onclick: () => sortBy("name") , "aria-sort": key === "name" ? (dir < 0 ? "descending" : "ascending") : null }, "Hitter"),
      cols.map(th))),
    el("tbody", {}, shown.map((h, i) => el("tr", {
      class: h.id === state.player ? "is-selected" : null, tabindex: "0",
      onclick: () => selectPlayer(h.id), onkeydown: (e) => { if (e.key === "Enter") selectPlayer(h.id); },
    },
      el("td", { class: "l rank" }, i + 1),
      el("td", { class: "l" }, el("span", { class: "pname" }, h.name),
        el("span", { class: "meta" }, `${h.team} · ${h.bats}${h.bat_src !== "assumed" ? ` · ${fmt.f0(h.bat_len)}/${fmt.f0(h.bat_oz)} bat` : ""}`)),
      cols.map((c) => {
        const v = h[c.key];
        if (c.key === "evoe") return el("td", {}, evoeCell(v, scale, lim));
        if (c.key === "peerPct") return el("td", {}, nil(v) ? "–" : el("span", { class: "pct-chip", style: `background:${ratingWash(v)}` }, Math.max(1, Math.min(99, Math.round(v * 100)))));
        return el("td", {}, show(v, c.f));
      })))),
  );
  $("board-more").hidden = sorted.length <= BOARD_LIMIT;
  $("board-more").textContent = state.all ? "Show top 50" : `Show all ${sorted.length}`;
  $("board-count").textContent = `${fmt.int(sorted.length)} hitters`;
}
function sortBy(key) {
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === "name" ? 1 : -1 };
  renderMain();
}

/* ------------------------------------------------------------------ player */
let playerToken = 0;
async function renderPlayerSection(pool) {
  const section = $("player");
  if (!state.player) { section.hidden = true; section.replaceChildren(); return; }
  const player = pool.find((h) => h.id === state.player) || HITTERS.find((h) => h.id === state.player && h.season === state.season);
  if (!player) {
    section.hidden = false;
    section.replaceChildren(el("p", { class: "empty" }, "This hitter has no batted balls in the selected season."),
      el("button", { class: "btn secondary sm", type: "button", onclick: () => selectPlayer(null) }, "Close"));
    return;
  }
  const comp = state.comp ? (pool.find((h) => h.id === state.comp) || HITTERS.find((h) => h.id === state.comp && h.season === state.season)) : null;
  const token = ++playerToken;
  section.classList.add("loading");
  const [swings, compSwings] = await Promise.all([swingsOf(player.id), comp ? swingsOf(comp.id) : null]);
  if (token !== playerToken) return;
  section.classList.remove("loading");
  renderPlayer(section, {
    player, comp, swings, compSwings, peersAll: pool, meta: META, season: state.season, minN: state.min,
    onSelect: (id) => selectPlayer(id, true),
    onComp: (id) => { state.comp = id; writeHash(); renderMain(); },
    onClose: () => selectPlayer(null),
  });
}
function selectPlayer(id, scroll = true) {
  state.player = id;
  if (!id || id === state.comp) state.comp = null;
  writeHash();
  renderMain().then(() => {
    if (id && scroll) $("player").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* ------------------------------------------------------------------ drivers + study */
function renderDrivers() {
  driverMultiples($("drivers"), DRIVERS.swing, state.driversView);
  contactMap($("contact-map"), $("contact-legend"), DRIVERS.contact_map);
  correlationBars($("hitter-drivers"), $("hitter-drivers-legend"), DRIVERS.hitter);
  $("min-stats").textContent = META.minBbeStats;
  const S = META.stability;
  const rows = Object.entries(S.yoy).map(([k, v]) => ({ k, ...v, split: k === "evoe_raw" ? S.split.resid : k === "bs" ? S.split.bs : null }));
  $("stability").replaceChildren(
    el("thead", {}, el("tr", {}, el("th", { class: "l" }, "Metric"), el("th", {}, "Season → next season r"), el("th", {}, "Hitter pairs"), el("th", {}, "Split-half r (full season)"))),
    el("tbody", {}, rows.map((r) => el("tr", {},
      el("td", { class: "l" }, r.label), el("td", {}, fmt.f2(r.r)), el("td", {}, fmt.int(r.n)),
      el("td", {}, r.split ? fmt.f2(r.split.r_full) : "–")))));
}

function renderMethod() {
  const L = META.league;
  const yrs = META.seasons.map((s) => `${s} (${fmt.int(L[s].n_bip)} batted balls)`).join(", ");
  const p = (...c) => el("p", {}, ...c);
  $("method").replaceChildren(
    p(`Data: every regular-season ball in play with Hawk-Eye bat tracking from Baseball Savant, ${yrs}. 2023 tracking starts mid-July.`),
    el("h3", {}, "Competitive batted balls"),
    p("Bunts are removed. Then Savant's competitive-swing rule is applied per hitter-season: each hitter's slowest 10% of batted-ball swings are dropped unless the swing was 60+ mph and produced 90+ mph exit velo."),
    el("h3", {}, "Expected exit velo (xEV)"),
    p("For each season, exit velo is fit to a natural cubic spline in bat speed plus a linear pitch-speed term on all competitive batted balls. xEV is what a league-average hitter gets from that exact bat speed against that exact pitch speed. EV over expected = the hitter's average of (EV − xEV), shrunk toward the league with empirical Bayes so small samples don't top the board."),
    el("h3", {}, "EV90 over expected"),
    p("A hitter's 90th-percentile exit velo minus what hitters with the same average bat speed and pitch mix reach (quadratic fit across hitters, weighted by batted balls), also shrunk. Use it to separate hitters who mishit a lot from hitters whose best contact underperforms their speed."),
    el("h3", {}, "Bat-adjusted EV over expected"),
    p(`Statcast doesn't track bat length or weight, so a heavier bat shows up as extra EV over expected. Bat specs listed in data/bat_specs.csv are run through a collision model. Collision efficiency q = (e − r)/(1 + r), where r = ball mass ÷ the bat's effective mass at the sweet spot (6 in from the tip). Effective mass comes from the bat's weight and its moment of inertia about the center of mass. The bat's shape is scaled by length, calibrated so a ${META.bat.default[0]} in / ${META.bat.default[1]} oz bat gives q ≈ ${fmt.f2(META.bat.q_default)} with e = ${META.bat.cor}. Each batted ball's EV is rescaled to what the standard bat would have produced at the same contact quality (EV × standard max EV ÷ the hitter's max EV). Hitters not listed are assumed to use the standard bat (${META.bat.n_specs} listed now).`),
    p("Length's benefit (a longer lever) is already inside the measured bat speed. At the measuring point it also lowers effective mass, so a longer bat at the same weight reads as slightly less efficient. The model scales one bat shape, so end-loaded or balanced models will differ somewhat."),
    el("h3", {}, "Height and weight"),
    p("Listed height and weight come from the MLB Stats API roster record: one current value per hitter, not a measurement by season. Height ÷ weight is inches per pound, so lower means more mass for the frame. The body section correlates these with each hitter's averages, using whatever filters are set. Outliers are hitters furthest above or below the straight-line fit, in standard deviations of the misses. Spd vs size and EV vs size in the leaderboard use height and weight together."),
    el("h3", {}, "Face-to-path"),
    el("ul", {},
      el("li", {}, "Vertical: launch angle − attack angle. Near 0 means the ball left along the bat's vertical path (centered on the barrel). + = undercut, − = topped."),
      el("li", {}, "Horizontal: spray angle − attack direction, both in pull-negative degrees. Near 0 means the barrel was square to its own path; it captures the barrel's horizontal angle at contact."),
      el("li", {}, "Plane match: attack angle + the pitch's vertical approach angle at the plate (computed from the trajectory fit). 0 = the bat travelling straight back up the pitch's path."),
    ),
    el("h3", {}, "Caveats"),
    el("ul", {},
      el("li", {}, "Bat weight and length aren't tracked by Statcast. The bat-adjusted column only corrects hitters listed in data/bat_specs.csv; for everyone else, some EV over expected may be equipment, not motion."),
      el("li", {}, "Bat speed is measured 6 inches from the barrel tip. Contact nearer the hands or the end loses EV that shows up here as below expected."),
      el("li", {}, "Batted-ball path metrics are conditional on contact; the attack angle, tilt, depth and length columns use Savant's all-competitive-swing values."),
      el("li", {}, "Video: the Watch buttons look up the pitch's play id from the MLB Stats API and open the Baseball Savant clip. If a clip can't be resolved, the game feed opens instead."),
    ),
  );
  $("generated").textContent = `Games through ${META.dataThrough} · built ${META.generated.replace("T", " ")}`;
}

/* ------------------------------------------------------------------ body size */
function renderBodySection(rows) {
  $("body-chart-title").textContent = `${BODY_X[state.bodyX].label} vs ${BODY_Y[state.bodyY].lc}`;
  renderBody({
    matrixEl: $("body-matrix"), takeawayEl: $("body-takeaway"), scatterEl: $("body-scatter"),
    legendEl: $("body-legend"), statEl: $("body-stat"), outliersEl: $("body-outliers"),
  }, rows, state, {
    onPick: (x, y) => { state.bodyX = x; state.bodyY = y; syncControls(); writeHash(); renderBodySection(rows); },
    onSelect: (id) => selectPlayer(id, true),
  });
}

/* ------------------------------------------------------------------ assemble */
async function renderMain() {
  const pool = seasonPool();
  const rows = filtered(pool);
  $("scatter-sub").textContent = `${fmt.int(rows.length)} hitters · ${state.season ? state.season : "all seasons"} · ${state.min}+ competitive batted balls. Above the line = more exit velo than their bat speed predicts.`;
  hitterScatter($("scatter"), $("scatter-legend"), rows, {
    yMode: state.y, selectedId: state.player, compId: state.comp, colorLimit: 3,
    onSelect: (id) => selectPlayer(id, true),
  });
  renderBoard(rows);
  renderBodySection(rows);
  const names = [...new Map(pool.map((h) => [h.name, h])).values()].sort((a, b) => a.name.localeCompare(b.name));
  $("player-list").replaceChildren(...names.map((h) => el("option", { value: h.name })));
  $("f-bs-min").placeholder = rows.length ? fmt.f1(d3.min(pool, (h) => h.bs)) : "";
  $("f-bs-max").placeholder = rows.length ? fmt.f1(d3.max(pool, (h) => h.bs)) : "";
  await renderPlayerSection(pool);
}

function syncControls() {
  $("f-season").value = String(state.season);
  $("f-min").value = String(state.min);
  $("f-bs-min").value = state.bsMin ?? "";
  $("f-bs-max").value = state.bsMax ?? "";
  $("f-bats").value = state.bats;
  for (const b of $("y-toggle").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.y === state.y));
  for (const b of $("col-toggle").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.cols === state.cols));
  for (const b of $("drivers-view").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.view === state.driversView));
  for (const b of $("body-x").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.x === state.bodyX));
  for (const b of $("body-y").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.y === state.bodyY));
}

function bindControls() {
  const rerender = () => { writeHash(); renderTiles(); renderMain(); };
  $("f-season").addEventListener("change", (e) => { state.season = +e.target.value; state.all = false; rerender(); });
  $("f-min").addEventListener("change", (e) => { state.min = +e.target.value; rerender(); });
  const bs = (k) => (e) => { const v = e.target.value.trim(); state[k] = v === "" || Number.isNaN(+v) ? null : +v; rerender(); };
  $("f-bs-min").addEventListener("change", bs("bsMin"));
  $("f-bs-max").addEventListener("change", bs("bsMax"));
  $("f-bats").addEventListener("change", (e) => { state.bats = e.target.value; rerender(); });
  $("f-search").addEventListener("change", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const pool = HITTERS.filter((h) => h.season === state.season);
    const hit = pool.find((h) => h.name.toLowerCase() === q) || pool.filter((h) => h.name.toLowerCase().includes(q)).sort((a, b) => b.n - a.n)[0];
    if (hit) { e.target.value = ""; selectPlayer(hit.id, true); }
  });
  $("f-reset").addEventListener("click", () => {
    Object.assign(state, { min: 100, bsMin: null, bsMax: null, bats: "all", y: "ev", cols: "output", player: null, comp: null, all: false, sort: { key: "evoe", dir: -1 }, bodyX: "ht", bodyY: "bs" });
    syncControls(); rerender();
  });
  $("y-toggle").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.y = b.dataset.y; syncControls(); writeHash(); renderMain(); });
  $("col-toggle").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.cols = b.dataset.cols; syncControls(); writeHash(); renderMain(); });
  $("drivers-view").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.driversView = b.dataset.view; syncControls(); renderDrivers(); });
  $("body-x").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.bodyX = b.dataset.x; syncControls(); writeHash(); renderBodySection(filtered(seasonPool())); });
  $("body-y").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.bodyY = b.dataset.y; syncControls(); writeHash(); renderBodySection(filtered(seasonPool())); });
  $("board-more").addEventListener("click", () => { state.all = !state.all; renderMain(); });
  $("theme-toggle").addEventListener("click", () => {
    const dark = cssVar("color-scheme") === "dark" || document.documentElement.dataset.theme === "dark";
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("evlab-theme", next); } catch (e) { /* storage unavailable */ }
    renderAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());
  window.addEventListener("hashchange", () => {
    readHash();
    if (!(state.season in META.league)) state.season = META.seasons[META.seasons.length - 1];
    syncControls();
    renderAll();
  });
  let lastW = window.innerWidth, t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 20) { lastW = window.innerWidth; renderAll(); } }, 150);
  });
}

function renderAll() { renderTiles(); renderMain(); renderDrivers(); }

async function init() {
  try {
    [META, HITTERS, DRIVERS] = await Promise.all([loadJSON("data/meta.json"), loadJSON("data/hitters.json"), loadJSON("data/drivers.json")]);
  } catch (e) {
    document.querySelector("main").prepend(el("p", { class: "note" }, `Couldn't load data (${e.message}). Run pipeline/build.py, then serve the web/ folder.`));
    return;
  }
  const seasons = [...META.seasons].sort((a, b) => b - a);
  $("f-season").replaceChildren(
    ...seasons.map((s) => el("option", { value: s }, META.league[s].partial ? `${s} (partial)` : String(s))),
    el("option", { value: 0 }, "All seasons"));
  state.season = seasons[0];
  readHash();
  if (!(state.season in META.league)) state.season = seasons[0];
  syncControls();
  bindControls();
  renderMethod();
  renderAll();
}

init();
