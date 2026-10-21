"""Turn raw Statcast batted balls into the study's models and the web tool's data files.

    .venv/bin/python pipeline/build.py

Core idea: for every competitive batted ball, predict the exit velocity a league-average
hitter gets from that same bat speed against that same pitch speed (xEV). A hitter's
EV over expected (EVOE) is the average of (EV - xEV) across their batted balls.
"""

import argparse
import json
import math
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data"
SEASONS = sorted(int(p.name) for p in (RAW / "statcast").glob("[0-9][0-9][0-9][0-9]") if p.is_dir())
PARTIAL_SEASONS = {2023: "Bat tracking began mid-July 2023"}


def season_note(season: int, last_game: date) -> str | None:
    """Flag a partial season: 2023's late tracking start, or the season currently in progress."""
    if season in PARTIAL_SEASONS:
        return PARTIAL_SEASONS[season]
    if season == date.today().year and last_game < date(season, 9, 26):
        return f"Season in progress, games through {last_game:%b %-d}"
    return None
N_SHARDS = 64
MIN_BBE_STATS = 150  # hitter-seasons used for correlations / stability

# Bat specs: optional per-hitter length/weight. Everyone not listed is assumed to swing the default.
BAT_SPECS = ROOT / "data" / "bat_specs.csv"
DEFAULT_BAT = (34.0, 32.0)  # length (in), weight (oz)
# Free-bat collision model (Nathan): q = (e - r) / (1 + r), r = ball mass / bat effective mass at
# the impact point, M_eff = 1 / (1/M + b^2 / I_cm). Impact point = Statcast's sweet spot, 6 in from
# the tip. Bat shape scales with length: balance point and radius of gyration are fixed fractions
# of length, the latter calibrated so a 34 in / 32 oz bat gives q = 0.20 (MOI ~10,500 oz-in^2 about
# the 6 in pivot, typical for MLB wood).
BALL_OZ = 5.125
BAT_COR = 0.50
BALANCE_FRAC = 0.665
GYRATION_FRAC = 0.2121

NUM = [
    "release_speed", "vx0", "vy0", "vz0", "ax", "ay", "az", "plate_x", "plate_z",
    "launch_speed", "launch_angle", "hit_distance_sc", "hc_x", "hc_y", "bat_speed",
    "swing_length", "attack_angle", "attack_direction", "swing_path_tilt",
    "intercept_ball_minus_batter_pos_x_inches", "intercept_ball_minus_batter_pos_y_inches",
    "estimated_woba_using_speedangle", "at_bat_number", "pitch_number", "game_pk",
    "batter", "pitcher",
]
TXT = [
    "game_date", "player_name", "stand", "p_throws", "pitch_type", "events", "des",
    "bb_type", "home_team", "away_team", "inning_topbot",
]
PITCH_GROUP = {
    **dict.fromkeys(["FF", "SI", "FC", "FA"], "FB"),
    **dict.fromkeys(["SL", "ST", "CU", "KC", "SV", "CS", "SC"], "BR"),
    **dict.fromkeys(["CH", "FS", "FO", "KN", "EP"], "OS"),
}
EVENT_CODE = {
    "single": "1B", "double": "2B", "triple": "3B", "home_run": "HR",
    "field_out": "OUT", "force_out": "OUT", "grounded_into_double_play": "GDP",
    "double_play": "DP", "fielders_choice": "FC", "fielders_choice_out": "FC",
    "field_error": "E", "sac_fly": "SF", "sac_fly_double_play": "SF", "triple_play": "TP",
}


# ---------------------------------------------------------------- load + derive


def load_season(season: int) -> pd.DataFrame:
    files = sorted((RAW / "statcast" / str(season)).glob("*.csv"))
    frames = [pd.read_csv(f, usecols=lambda c: c in NUM + TXT, low_memory=False) for f in files]
    d = pd.concat(frames, ignore_index=True)
    for c in NUM:
        d[c] = pd.to_numeric(d[c], errors="coerce")
    d["season"] = season
    return d.drop_duplicates(["game_pk", "at_bat_number", "pitch_number"])


def derive(d: pd.DataFrame) -> pd.DataFrame:
    d = d[d.bat_speed.between(30, 95) & d.launch_speed.between(10, 125) & d.release_speed.between(50, 106)].copy()
    d = d[~d.des.fillna("").str.contains("bunt", case=False)]

    # Competitive swings, Savant's rule applied per hitter-season: drop each hitter's slowest
    # 10% unless the swing was 60+ mph and produced 90+ mph exit velocity.
    p10 = d.groupby(["season", "batter"]).bat_speed.transform(lambda s: s.quantile(0.10))
    d = d[(d.bat_speed >= p10) | ((d.bat_speed >= 60) & (d.launch_speed >= 90))].copy()

    # Pitch at the front of the plate (y = 17/12 ft) from the 9-parameter trajectory fit.
    yf = 17 / 12
    t = (-d.vy0 - np.sqrt(d.vy0**2 - 2 * d.ay * (50 - yf))) / d.ay
    vx, vy, vz = d.vx0 + d.ax * t, d.vy0 + d.ay * t, d.vz0 + d.az * t
    d["plate_speed"] = np.sqrt(vx**2 + vy**2 + vz**2) * 3600 / 5280
    d["vaa"] = -np.degrees(np.arctan(vz / vy))  # negative = descending

    # Savant's maximum possible EV for a swing/pitch pair; efficiency = share of it achieved.
    d["max_ev"] = 1.23 * d.bat_speed + 0.23 * d.release_speed
    d["eff"] = d.launch_speed / d.max_ev

    # Spray angle in the attack-direction convention: negative = pull side, positive = oppo.
    spray = np.degrees(np.arctan((d.hc_x - 125.42) / (198.27 - d.hc_y)))
    d["spray"] = np.where(d.stand == "L", -spray, spray)

    # "Face-to-path" gaps. Vertical: launch angle vs the bat's vertical path at contact
    # (+ = ball went up more than the bat was travelling = undercut). Horizontal: where the
    # ball went vs the direction the sweet spot was travelling (+ = more oppo than the path).
    d["gap_v"] = d.launch_angle - d.attack_angle
    d["gap_h"] = d.spray - d.attack_direction
    # Plane match: attack angle vs the pitch's descent. 0 = bat travelling straight up the
    # pitch's path; + = steeper uppercut than the pitch plane.
    d["plane"] = d.attack_angle + d.vaa
    d["ix"] = d.intercept_ball_minus_batter_pos_x_inches
    d["iy"] = d.intercept_ball_minus_batter_pos_y_inches
    d["team"] = np.where(d.inning_topbot == "Bot", d.home_team, d.away_team)
    d["pgroup"] = d.pitch_type.map(PITCH_GROUP).fillna("OT")
    return d


# ---------------------------------------------------------------- xEV model


def collision_q(length, weight):
    """Collision efficiency at the sweet spot for a bat of this length (in) and weight (oz)."""
    length, weight = np.asarray(length, float), np.asarray(weight, float)
    b = (length - 6.0) - BALANCE_FRAC * length  # sweet spot's distance from the center of mass
    i_cm = weight * (GYRATION_FRAC * length) ** 2
    m_eff = 1 / (1 / weight + b**2 / i_cm)
    r = BALL_OZ / m_eff
    return (BAT_COR - r) / (1 + r)


def load_bat_specs(d: pd.DataFrame) -> dict:
    """batter id -> (length, weight, source). Rows can give player_id, or just a name to match."""
    if not BAT_SPECS.exists():
        return {}
    specs = pd.read_csv(BAT_SPECS, dtype=str).fillna("")
    last_first = d.groupby("batter").player_name.last()
    by_name = {}
    for bid, nm in last_first.items():
        last, _, first = str(nm).partition(", ")
        by_name.setdefault(f"{first} {last}".strip().lower(), []).append(int(bid))
    out = {}
    for row in specs.itertuples():
        try:
            length, weight = float(row.length_in), float(row.weight_oz)
        except ValueError:
            print(f"  ! bat specs: bad length/weight for {row.name or row.player_id}, skipped")
            continue
        if not (30 <= length <= 37 and 28 <= weight <= 36):
            print(f"  ! bat specs: {row.name or row.player_id} {length} in / {weight} oz looks off, using it anyway")
        if row.player_id.strip():
            bid = int(float(row.player_id))
        else:
            ids = by_name.get(row.name.strip().lower(), [])
            if len(ids) != 1:
                print(f"  ! bat specs: name '{row.name}' matched {len(ids)} hitters; add player_id")
                continue
            bid = ids[0]
        out[bid] = (length, weight, row.source.strip() or "listed")
    print(f"bat specs for {len(out)} hitters; everyone else assumed {DEFAULT_BAT[0]:g} in / {DEFAULT_BAT[1]:g} oz")
    return out


def bat_adjusted_ev(d: pd.DataFrame, specs: dict) -> pd.Series:
    """Each batted ball's EV as if hit with the default bat, holding contact quality fixed:
    EV scales by max EV (q * pitch + (1 + q) * bat speed) under the default bat vs the hitter's."""
    length = d.batter.map(lambda b: specs.get(b, DEFAULT_BAT)[0]).astype(float)
    weight = d.batter.map(lambda b: specs.get(b, DEFAULT_BAT)[1]).astype(float)
    q0, qh = collision_q(*DEFAULT_BAT), collision_q(length, weight)
    ps = d.plate_speed.fillna(0.92 * d.release_speed)
    return d.launch_speed * (q0 * ps + (1 + q0) * d.bat_speed) / (qh * ps + (1 + qh) * d.bat_speed)


def rcs_basis(x: np.ndarray, knots: np.ndarray) -> np.ndarray:
    """Restricted (natural) cubic spline basis, Harrell's parameterisation."""
    k, K = knots, len(knots)
    pos3 = lambda v: np.clip(v, 0, None) ** 3  # noqa: E731
    cols = [x]
    for j in range(K - 2):
        cols.append(
            (pos3(x - k[j])
             - pos3(x - k[K - 2]) * (k[K - 1] - k[j]) / (k[K - 1] - k[K - 2])
             + pos3(x - k[K - 1]) * (k[K - 2] - k[j]) / (k[K - 1] - k[K - 2]))
            / (k[K - 1] - k[0]) ** 2
        )
    return np.column_stack(cols)


class XevModel:
    """EV ~ natural spline(bat speed) + linear(pitch speed), fit by OLS for one season."""

    def __init__(self, d: pd.DataFrame):
        self.knots = np.quantile(d.bat_speed, [0.05, 0.275, 0.5, 0.725, 0.95])
        X = self._design(d.bat_speed.values, d.release_speed.values)
        y = d.launch_speed.values
        self.beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        resid = y - X @ self.beta
        self.r2 = 1 - resid.var() / y.var()
        self.resid_sd = resid.std()
        self.ps_mean = d.release_speed.mean()
        self.ps_coef = self.beta[-1]

    def _design(self, bs, ps):
        return np.column_stack([np.ones_like(bs), rcs_basis(bs, self.knots), ps])

    def predict(self, bs, ps):
        return self._design(np.asarray(bs, float), np.asarray(ps, float)) @ self.beta


def ev_adjusted(d: pd.DataFrame, model: XevModel) -> pd.Series:
    """EV re-expressed as if every pitch arrived at the league-average pitch speed."""
    return d.launch_speed - model.ps_coef * (d.release_speed - model.ps_mean)


def windows(bs: np.ndarray, grid: np.ndarray, min_n: int = 300, max_w: float = 4.0):
    """For each grid bat speed, the indices of batted balls within a +/-1 mph window
    (widened in 0.5 mph steps until it holds min_n balls). Yields (grid value, idx, ok)."""
    order = np.argsort(bs)
    sbs = bs[order]
    for g in grid:
        w = 1.0
        while True:
            lo, hi = np.searchsorted(sbs, g - w), np.searchsorted(sbs, g + w, side="right")
            if hi - lo >= min_n or w >= max_w:
                break
            w += 0.5
        yield g, order[lo:hi], hi - lo >= min_n


def conditional_pct(d: pd.DataFrame, model: XevModel) -> np.ndarray:
    """Each batted ball's EV percentile among league batted balls at the same bat speed
    (pitch-speed adjusted). 0.5 = median EV for that bat speed; 0.9+ = top 10%."""
    bs = d.bat_speed.values
    ev = ev_adjusted(d, model).values
    grid = np.arange(np.floor(bs.min()), np.ceil(bs.max()) + 0.5, 0.5)
    nearest = np.clip(np.round((bs - grid[0]) / 0.5).astype(int), 0, len(grid) - 1)
    pct = np.full(len(d), np.nan)
    for i, (g, idx, _) in enumerate(windows(bs, grid)):
        members = np.where(nearest == i)[0]
        if len(members) == 0:
            continue
        ref = np.sort(ev[idx])
        lo = np.searchsorted(ref, ev[members], side="left")
        hi = np.searchsorted(ref, ev[members], side="right")
        pct[members] = (lo + hi) / 2 / len(ref)
    return pct


def league_curves(d: pd.DataFrame, model: XevModel) -> dict:
    """xEV and EV percentiles by bat speed, for chart backdrops (pitch speed held at mean)."""
    grid = np.arange(55, 87.5, 0.5)
    ps = np.full_like(grid, model.ps_mean)
    out = {"bs": grid.round(1).tolist(), "xev": model.predict(grid, ps).round(2).tolist()}
    ev = ev_adjusted(d, model).values
    qs = {10: [], 50: [], 90: []}
    for g, idx, ok in windows(d.bat_speed.values, grid):
        for q in qs:
            qs[q].append(round(float(np.percentile(ev[idx], q)), 2) if ok else None)
    for q, vals in qs.items():
        out[f"p{q}"] = vals
    # Exit-velocity ceiling from Savant's squared-up formula, for reference.
    out["max_ev"] = (1.23 * grid + 0.23 * model.ps_mean).round(2).tolist()
    return out


def density(d: pd.DataFrame) -> dict:
    bs_edges = np.arange(55, 88, 1.0)
    ev_edges = np.arange(30, 124, 2.0)
    h, _, _ = np.histogram2d(d.bat_speed, d.launch_speed, bins=[bs_edges, ev_edges])
    return {
        "bs0": 55, "bsStep": 1, "ev0": 30, "evStep": 2,
        "counts": h.astype(int).tolist(),
    }


# ---------------------------------------------------------------- hitter metrics


def eb_shrink(est: pd.Series, var: pd.Series, fit_mask: pd.Series) -> pd.Series:
    """Empirical-Bayes (method of moments) shrinkage of noisy per-hitter estimates."""
    e, v = est[fit_mask], var[fit_mask]
    w = 1 / v
    mu = float((e * w).sum() / w.sum())
    tau2 = max(float(e.var() - v.mean()), 1e-6)
    return mu + tau2 / (tau2 + var) * (est - mu)


def boot_quantile_var(x: np.ndarray, q: float, rng, n_boot: int = 200) -> float:
    if len(x) < 5:
        return np.nan
    idx = rng.integers(0, len(x), size=(n_boot, len(x)))
    return float(np.quantile(x[idx], q, axis=1).var())


def expected_ev90(sub: pd.DataFrame) -> np.ndarray:
    """Hitter-level fit: a hitter's 90th-percentile EV from their average bat speed and the
    average pitch speed they faced (quadratic in bat speed, weighted by batted balls)."""
    fit = sub[sub.n >= 100]
    X = lambda t: np.column_stack([np.ones(len(t)), t.bs, t.bs**2, t.ps])  # noqa: E731
    w = np.sqrt(fit.n.values)
    beta, *_ = np.linalg.lstsq(X(fit) * w[:, None], fit.ev90.values * w, rcond=None)
    return X(sub) @ beta


def hitter_table(d: pd.DataFrame, rng, specs: dict) -> pd.DataFrame:
    """One row per hitter per season, plus a pooled 'all seasons' row (season = 0)."""
    rows = []
    for key in ("season", "pooled"):
        groups = d.groupby(["season", "batter"]) if key == "season" else d.groupby("batter")
        for gk, g in groups:
            season, batter = (gk if key == "season" else (0, gk))
            n = len(g)
            r = g.resid.values
            stands = g.stand.value_counts(normalize=True)
            rows.append({
                "season": int(season),
                "id": int(batter),
                "name": g.player_name.iloc[-1],
                "team": g.team.mode().iloc[0] if season else g.sort_values("game_date").team.iloc[-1],
                "bats": "S" if (len(stands) > 1 and stands.min() >= 0.1) else stands.index[0],
                "n": n,
                "bs": g.bat_speed.mean(),
                "bs_sd": g.bat_speed.std(),
                "ev": g.launch_speed.mean(),
                "xev": g.xev.mean(),
                "evoe_raw": r.mean(),
                "evoe_var": r.var(ddof=1) / n if n > 1 else np.nan,
                "evoe_bat_raw": g.resid_bat.mean(),
                "evoe_bat_var": g.resid_bat.var(ddof=1) / n if n > 1 else np.nan,
                "bat_adj": (g.ev_bat - g.launch_speed).mean(),
                "bat_len": specs.get(batter, DEFAULT_BAT)[0],
                "bat_oz": specs.get(batter, DEFAULT_BAT)[1],
                "bat_src": specs[batter][2] if batter in specs else "assumed",
                "ev90": np.percentile(g.launch_speed, 90),
                "ev90_var": boot_quantile_var(g.launch_speed.values, 0.9, rng),
                "eff": g.eff.mean(),
                "sq": (g.eff >= 0.8).mean(),
                "hh": (g.launch_speed >= 95).mean(),
                "la": g.launch_angle.mean(),
                "ss": g.launch_angle.between(8, 32).mean(),
                "ps": g.release_speed.mean(),
                "aa": g.attack_angle.mean(),
                "ad": g.attack_direction.mean(),
                "tilt": g.swing_path_tilt.mean(),
                "ix": g.ix.mean(),
                "iy": g.iy.mean(),
                "plane": g.plane.mean(),
                "gap_v": g.gap_v.abs().median(),
                "gap_h": g.gap_h.abs().median(),
                "spray": g.spray.mean(),
                "xwoba": g.estimated_woba_using_speedangle.mean(),
            })
    h = pd.DataFrame(rows)
    for scope in (h.season > 0, h.season == 0):
        sub = h[scope]
        fit = sub.n >= 100
        h.loc[scope, "evoe"] = eb_shrink(sub.evoe_raw, sub.evoe_var, fit)
        h.loc[scope, "evoe_bat"] = eb_shrink(sub.evoe_bat_raw, sub.evoe_bat_var, fit)
        # Top-end: EV90 over what hitters with the same average bat speed reach.
        top_raw = pd.Series(np.nan, index=sub.index)
        for _, ss in sub.groupby("season"):
            top_raw[ss.index] = ss.ev90 - expected_ev90(ss)
        h.loc[scope, "top_raw"] = top_raw
        h.loc[scope, "top"] = eb_shrink(top_raw, sub.ev90_var.fillna(sub.ev90_var.max()), fit)
    return h


def attach_leaderboards(h: pd.DataFrame) -> pd.DataFrame:
    """Swing-path metrics over ALL competitive swings (not only balls in play) from Savant."""
    lb_rows = []
    for season in sorted(h.season.unique()):
        if not season:
            continue
        sp = RAW / "leaderboards" / f"swing_path_{season}.csv"
        bt = RAW / "leaderboards" / f"bat_tracking_{season}.csv"
        if not sp.exists():
            continue
        p = pd.read_csv(sp)
        if p.empty:
            continue
        # Switch hitters can appear once per side: swing-weighted average them.
        w = p.competitive_swings
        cols = ["avg_bat_speed", "swing_tilt", "attack_angle", "attack_direction",
                "ideal_attack_angle_rate", "avg_intercept_y_vs_plate", "avg_intercept_y_vs_batter",
                "avg_batter_y_position", "avg_batter_x_position"]
        for c in cols:
            p[c] = pd.to_numeric(p[c], errors="coerce") * w
        p = p.groupby("id", as_index=False)[cols + ["competitive_swings"]].sum()
        for c in cols:
            p[c] = p[c] / p.competitive_swings
        if bt.exists():
            b = pd.read_csv(bt)
            if not b.empty:
                b = b[["id", "swing_length", "squared_up_per_bat_contact", "blast_per_bat_contact",
                       "whiff_per_swing", "hard_swing_rate"]].drop_duplicates("id")
                p = p.merge(b, on="id", how="left")
        p["season"] = season
        lb_rows.append(p)
    lb = pd.concat(lb_rows, ignore_index=True).rename(columns={
        "avg_bat_speed": "lb_bs", "swing_tilt": "lb_tilt", "attack_angle": "lb_aa",
        "attack_direction": "lb_ad", "ideal_attack_angle_rate": "lb_ideal",
        "avg_intercept_y_vs_plate": "lb_iy_plate", "avg_intercept_y_vs_batter": "lb_iy",
        "avg_batter_y_position": "lb_stance_y", "avg_batter_x_position": "lb_stance_x",
        "competitive_swings": "lb_swings", "swing_length": "lb_len",
        "squared_up_per_bat_contact": "lb_sq", "blast_per_bat_contact": "lb_blast",
        "whiff_per_swing": "lb_whiff", "hard_swing_rate": "lb_fast",
    })
    lb["lb_bs"] = pd.to_numeric(lb.lb_bs, errors="coerce")
    for c in ["lb_len", "lb_sq", "lb_blast", "lb_whiff", "lb_fast"]:
        lb[c] = pd.to_numeric(lb[c], errors="coerce") if c in lb else np.nan
    h = h.merge(lb, on=["season", "id"], how="left")
    # Pooled rows: swing-weighted average across seasons.
    lbc = [c for c in lb.columns if c.startswith("lb_") and c != "lb_swings"]
    pooled = lb.copy()
    for c in lbc:
        pooled[c] = pooled[c] * pooled.lb_swings
    pooled = pooled.groupby("id")[lbc + ["lb_swings"]].sum(min_count=1)
    for c in lbc:
        pooled[c] = pooled[c] / pooled.lb_swings
    pooled = pooled.reset_index()
    mask = h.season == 0
    h.loc[mask, lbc + ["lb_swings"]] = (
        h.loc[mask, ["id"]].merge(pooled, on="id", how="left")[lbc + ["lb_swings"]].values
    )
    return h


def attach_people(h: pd.DataFrame) -> pd.DataFrame:
    """Listed height (in), weight (lb) and position from the MLB Stats API (fetch_statcast.py).
    Weight/height ratio = pounds per inch: higher = more mass for the frame."""
    f = RAW / "people.csv"
    if not f.exists():
        print("  ! no data/raw/people.csv; run fetch_statcast.py for height/weight")
        return h.assign(ht=np.nan, wt=np.nan, wtht=np.nan, pos="")
    p = pd.read_csv(f)[["id", "height_in", "weight_lb", "position"]].rename(
        columns={"height_in": "ht", "weight_lb": "wt", "position": "pos"})
    p["wtht"] = p.wt / p.ht
    h = h.merge(p, on="id", how="left")
    h["pos"] = h.pos.fillna("")
    print(f"height/weight for {h.ht.notna().mean():.0%} of hitter rows")
    return h


STANCE_COLS = {
    "avg_batter_y_position": "st_depth",   # in behind the front of the plate (higher = deeper)
    "avg_batter_x_position": "st_off",     # in off the plate's inside edge (higher = farther)
    "avg_foot_sep": "st_feet",             # in between the feet
    "avg_stance_angle": "st_angle",        # deg; negative = open, positive = closed
}


def attach_stance(h: pd.DataFrame, d: pd.DataFrame) -> pd.DataFrame:
    """Savant batting stance per hitter-season. Switch hitters have one row per side, averaged by
    their batted balls from each side; pooled rows average seasons by batted balls."""
    frames = []
    for season in sorted(s for s in h.season.unique() if s):
        f = RAW / "leaderboards" / f"batting_stance_{season}.csv"
        if f.exists():
            frames.append(pd.read_csv(f).assign(season=season))
    if not frames:
        print("  ! no batting stance files; run fetch_statcast.py")
        return h.assign(**{c: np.nan for c in STANCE_COLS.values()})
    st = pd.concat(frames, ignore_index=True).rename(columns=STANCE_COLS)
    side_n = d.groupby(["season", "batter", "stand"]).size().rename("w").reset_index()
    st = st.merge(side_n, left_on=["season", "id", "side"], right_on=["season", "batter", "stand"], how="left")
    st["w"] = st.w.fillna(1)
    cols = list(STANCE_COLS.values())
    wavg = lambda g: pd.Series({c: np.average(g[c], weights=g.w) for c in cols} | {"w": g.w.sum()})  # noqa: E731
    per_season = st.groupby(["season", "id"]).apply(wavg, include_groups=False).reset_index()
    h = h.merge(per_season.drop(columns="w"), on=["season", "id"], how="left")
    pooled = per_season.groupby("id").apply(wavg, include_groups=False).reset_index().drop(columns="w")
    mask = h.season == 0
    h.loc[mask, cols] = h.loc[mask, ["id"]].merge(pooled, on="id", how="left")[cols].values
    print(f"batting stance for {h.st_feet.notna().mean():.0%} of hitter rows")
    return h


# ---------------------------------------------------------------- study outputs


def stability(h: pd.DataFrame, d: pd.DataFrame, rng) -> dict:
    """Is EV-over-expected a repeatable trait? Year-to-year and split-half reliability."""
    hs = h[h.season > 0]
    metrics = {"evoe_raw": "EV over expected", "top_raw": "EV90 over expected", "bs": "Bat speed",
               "ev": "Avg exit velo", "sq": "Squared-up rate (BIP)", "la": "Launch angle"}
    yoy = {}
    for m, label in metrics.items():
        pairs = []
        for s in sorted(hs.season.unique())[:-1]:
            a = hs[(hs.season == s) & (hs.n >= MIN_BBE_STATS)][["id", m]]
            b = hs[(hs.season == s + 1) & (hs.n >= MIN_BBE_STATS)][["id", m]]
            pairs.append(a.merge(b, on="id", suffixes=("_a", "_b")))
        p = pd.concat(pairs)
        yoy[m] = {"label": label, "r": round(float(p[f"{m}_a"].corr(p[f"{m}_b"])), 3), "n": len(p)}

    # Split-half (odd/even batted ball) reliability within a season, Spearman-Brown corrected.
    split = {}
    q = d[["season", "batter", "resid", "bat_speed"]].copy()
    q["half"] = rng.integers(0, 2, len(q))
    big = q.groupby(["season", "batter"]).resid.transform("size") >= MIN_BBE_STATS
    g = q[big].groupby(["season", "batter", "half"]).agg(resid=("resid", "mean"), bs=("bat_speed", "mean")).unstack("half")
    for m, label in {"resid": "EV over expected", "bs": "Bat speed"}.items():
        r = g[(m, 0)].corr(g[(m, 1)])
        split[m] = {"label": label, "r_half": round(float(r), 3), "r_full": round(float(2 * r / (1 + r)), 3), "n": len(g)}
    return {"yoy": yoy, "split": split}


def binned_curve(d: pd.DataFrame, col: str, lo: float, hi: float, step: float) -> list:
    edges = np.arange(lo, hi + step, step)
    d = d[d[col].between(lo, hi)]
    idx = np.digitize(d[col], edges) - 1
    out = []
    for i in range(len(edges) - 1):
        g = d[idx == i]
        if len(g) < 200:
            continue
        out.append({
            "x": round(float((edges[i] + edges[i + 1]) / 2), 2),
            "n": len(g),
            "resid": round(float(g.resid.mean()), 3),
            "ci": round(float(1.96 * g.resid.std() / math.sqrt(len(g))), 3),
            "eff": round(float(g.eff.mean()), 4),
            "sq": round(float((g.eff >= 0.8).mean()), 4),
        })
    return out


SWING_DRIVERS = [
    # col, label, lo, hi, step, plain-language description
    ("gap_v", "Vertical face-to-path (launch angle − attack angle)", -60, 60, 4,
     "How far the ball's launch angle departs from the bat's vertical path. Near 0 = ball left along the bat's path (centered contact). + = undercut, − = topped."),
    ("gap_h", "Horizontal face-to-path (spray − attack direction)", -50, 50, 4,
     "How far the ball's direction departs from the sweet spot's horizontal travel. Near 0 = barrel squared to its own path. − = more pull than the path, + = more oppo."),
    ("plane", "Plane match (attack angle + pitch descent angle)", -25, 30, 2.5,
     "Attack angle relative to the pitch's descent. 0 = bat travelling straight up the pitch's path; + = steeper than the pitch plane, − = flatter / chopping."),
    ("attack_angle", "Attack angle (°)", -20, 35, 2.5,
     "Vertical angle the sweet spot is travelling at contact."),
    ("attack_direction", "Attack direction (°, − pull / + oppo)", -40, 40, 4,
     "Horizontal angle the sweet spot is travelling at contact."),
    ("swing_path_tilt", "Swing path tilt (°)", 10, 55, 2.5,
     "Steepness of the swing arc over the 40 ms before contact."),
    ("iy", "Contact depth (in. in front of batter)", -10, 60, 5,
     "Where contact happens along the pitch line, relative to the batter's body. Higher = further out in front."),
    ("ix", "Contact reach (in. from batter)", 15, 55, 2.5,
     "Lateral distance from the batter's body to the contact point."),
    ("plate_speed", "Pitch speed at plate (mph)", 65, 95, 2.5,
     "Faster pitches add EV by physics; xEV already credits this."),
]


def contact_map(d: pd.DataFrame) -> dict:
    """Mean EV over expected over the 2D face-to-path plane (horizontal x vertical gap)."""
    xe = np.arange(-40, 44, 4)
    ye = np.arange(-48, 52, 4)
    sub = d[d.gap_h.between(xe[0], xe[-1]) & d.gap_v.between(ye[0], ye[-1])]
    xi = np.digitize(sub.gap_h, xe) - 1
    yi = np.digitize(sub.gap_v, ye) - 1
    cells = []
    for (a, b), g in sub.groupby([xi, yi]):
        if len(g) >= 80:
            cells.append([int(a), int(b), round(float(g.resid.mean()), 2), len(g)])
    return {"x0": float(xe[0]), "xStep": 4, "y0": float(ye[0]), "yStep": 4,
            "nx": len(xe) - 1, "ny": len(ye) - 1, "cells": cells}


HITTER_DRIVERS = [
    ("lb_aa", "Attack angle (all swings)"), ("lb_ideal", "Ideal attack angle rate"),
    ("lb_ad", "Attack direction (all swings)"), ("lb_tilt", "Swing path tilt"),
    ("lb_iy", "Contact depth vs batter"), ("lb_len", "Swing length"),
    ("lb_whiff", "Whiff rate"), ("bs", "Bat speed (BIP)"), ("bs_sd", "Bat speed variability"),
    ("gap_v", "Median |vertical face-to-path|"), ("gap_h", "Median |horizontal face-to-path|"),
    ("plane", "Plane match (BIP)"), ("ps", "Pitch speed faced"),
]


def hitter_drivers(h: pd.DataFrame) -> list:
    hs = h[(h.season > 0) & (h.n >= MIN_BBE_STATS)]
    out = []
    for col, label in HITTER_DRIVERS:
        sub = hs[[col, "evoe", "top"]].dropna()
        if len(sub) < 30:
            continue
        out.append({
            "key": col, "label": label, "n": len(sub),
            "r_evoe": round(float(sub[col].corr(sub.evoe)), 3),
            "r_top": round(float(sub[col].corr(sub.top)), 3),
        })
    return sorted(out, key=lambda x: -abs(x["r_evoe"]))


# ---------------------------------------------------------------- bat speed estimator

EST_K = [5, 8, 10, 15, 20, 30, 50, 75, 100, 150]
EST_REPS = 6


def estimator_calibration(d: pd.DataFrame, rng) -> dict:
    """Calibrate 'average bat speed from exit velo readings' on MLB hitter-seasons.

    The line itself comes from full-season data: each hitter's EV90, put on a common pitch speed
    with the collision physics (EV moves q mph per mph of pitch at the plate), against their
    average bat speed. Its slope (~0.85) matches the physics value 1 / (1 + q). It deliberately
    does NOT shrink small samples toward the MLB average, so it stays usable for hitters far from
    MLB (youth, amateur). For each sample size k, random draws of k batted balls give the EV90
    bias to remove and the residual spread that becomes the error range. A fit on 2024-25
    applied to 2026 draws records out-of-sample accuracy."""
    q0 = float(collision_q(*DEFAULT_BAT))
    full = d[(d.season >= 2024) & d.plate_speed.notna()]
    ref_plate = float(full.plate_speed.mean())
    groups = [g for _, g in full.groupby(["season", "batter"]) if len(g) >= MIN_BBE_STATS]
    adj = lambda ev90, plate: ev90 + q0 * (ref_plate - plate)  # noqa: E731
    base = pd.DataFrame([{
        "season": g.season.iloc[0], "bs": g.bat_speed.mean(),
        "x": adj(np.percentile(g.launch_speed, 90), g.plate_speed.mean()),
    } for g in groups])
    b, a = np.polyfit(base.x, base.bs, 1)
    trb = base.season < 2026
    b_tr, a_tr = np.polyfit(base.x[trb], base.bs[trb], 1)
    out = {"a": round(float(a), 4), "b": round(float(b), 4), "k": EST_K, "bias": [], "rmse": [], "lo80": [],
           "hi80": [], "lo95": [], "hi95": [], "within2": [], "test_rmse": []}
    for k in EST_K:
        x_k, x_full, y, seas = [], [], [], []
        for g, row in zip(groups, base.itertuples()):
            ev, pl = g.launch_speed.values, g.plate_speed.values
            for _ in range(EST_REPS):
                idx = rng.choice(len(g), k, replace=False)
                x_k.append(adj(np.percentile(ev[idx], 90), pl[idx].mean()))
                x_full.append(row.x)
                y.append(row.bs)
                seas.append(row.season)
        x_k, x_full, y, seas = map(np.array, (x_k, x_full, y, seas))
        bias = float(np.mean(x_k - x_full))  # small samples read EV90 a little low/high on average
        res = y - (a + b * (x_k - bias))
        te = seas == 2026
        bias_tr = float(np.mean((x_k - x_full)[~te]))
        res_te = y[te] - (a_tr + b_tr * (x_k[te] - bias_tr))
        for key, v in [("bias", bias), ("rmse", np.sqrt(np.mean(res**2))),
                       ("lo80", np.percentile(res, 10)), ("hi80", np.percentile(res, 90)),
                       ("lo95", np.percentile(res, 2.5)), ("hi95", np.percentile(res, 97.5)),
                       ("within2", np.mean(np.abs(res) <= 2)), ("test_rmse", np.sqrt(np.mean(res_te**2)))]:
            out[key].append(round(float(v), 4))
    latest = full[full.season == full.season.max()]
    hitter_bs = latest.groupby("batter").bat_speed.agg(["mean", "size"])
    hitter_bs = hitter_bs[hitter_bs["size"] >= MIN_BBE_STATS]["mean"]
    out.update({
        "q0": round(q0, 4), "ref_plate": round(ref_plate, 2),
        "plate_factor": round(float(np.nanmedian(full.plate_speed / full.release_speed)), 4),
        "hitter_bs": sorted(round(float(v), 1) for v in hitter_bs), "hitter_season": int(full.season.max()),
        "n_hitter_seasons": len(groups),
    })
    print(f"estimator: bs = {a:.2f} + {b:.3f} * EV90_adj;",
          {k: (round(out["bias"][i], 2), round(out["rmse"][i], 2), round(out["test_rmse"][i], 2)) for i, k in enumerate(EST_K)})
    return out


# ---------------------------------------------------------------- export


def r(x, nd=1):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None
    return round(float(x), nd)


def export_bip(d: pd.DataFrame) -> None:
    """Per-hitter batted balls, sharded by batter id, in columnar arrays."""
    shard_dir = OUT / "bip"
    shard_dir.mkdir(parents=True, exist_ok=True)
    for old in shard_dir.glob("*.json"):
        old.unlink()
    cols = {
        "season": ("season", 0), "date": ("game_date", None), "pk": ("game_pk", 0),
        "ab": ("at_bat_number", 0), "pn": ("pitch_number", 0), "bs": ("bat_speed", 1),
        "ev": ("launch_speed", 1), "la": ("launch_angle", 0), "ps": ("release_speed", 1),
        "xev": ("xev", 1), "r": ("resid", 1), "cp": ("cpct100", 0), "eff": ("eff", 3), "pt": ("pitch_type", None),
        "pg": ("pgroup", None), "aa": ("attack_angle", 1), "ad": ("attack_direction", 1),
        "tilt": ("swing_path_tilt", 1), "ix": ("ix", 1), "iy": ("iy", 1), "spray": ("spray", 0),
        "gv": ("gap_v", 0), "gh": ("gap_h", 0), "px": ("plate_x", 2), "pz": ("plate_z", 2),
        "vaa": ("vaa", 1), "res": ("res", None), "dist": ("hit_distance_sc", 0),
        "stand": ("stand", None), "p_throws": ("p_throws", None), "pitcher": ("pitcher", 0),
    }
    d = d.sort_values(["batter", "game_date", "at_bat_number"]).copy()
    d["res"] = d.events.map(EVENT_CODE).fillna("OUT")
    d["cpct100"] = d.cpct * 100
    d["shard"] = d.batter % N_SHARDS
    for shard, sg in d.groupby("shard"):
        payload = {}
        for batter, g in sg.groupby("batter"):
            rec = {}
            for k, (c, nd) in cols.items():
                v = g[c]
                if nd is None:
                    rec[k] = v.fillna("").astype(str).tolist()
                elif nd == 0:
                    rec[k] = [None if pd.isna(x) else int(round(x)) for x in v]
                else:
                    rec[k] = [None if pd.isna(x) else round(float(x), nd) for x in v]
            payload[str(int(batter))] = rec
        (shard_dir / f"{int(shard):02d}.json").write_text(json.dumps(payload, separators=(",", ":")))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", type=int, nargs="+", default=SEASONS)
    args = ap.parse_args()
    rng = np.random.default_rng(7)
    OUT.mkdir(parents=True, exist_ok=True)
    seasons = [s for s in args.seasons if (RAW / "statcast" / str(s)).exists()]
    print("loading", seasons)
    d = pd.concat([derive(load_season(s)) for s in seasons], ignore_index=True)
    print(f"{len(d):,} competitive batted balls")

    models, curves, dens, league = {}, {}, {}, {}
    d["xev"] = np.nan
    for s in seasons:
        m = d.season == s
        model = XevModel(d[m])
        models[s] = model
        d.loc[m, "xev"] = model.predict(d.loc[m, "bat_speed"], d.loc[m, "release_speed"])
        d.loc[m, "cpct"] = conditional_pct(d[m], model)
    d["resid"] = d.launch_speed - d.xev
    specs = load_bat_specs(d)
    d["ev_bat"] = bat_adjusted_ev(d, specs)
    d["resid_bat"] = d.ev_bat - d.xev
    # Key 0 = all seasons pooled (a pooled model is used only for the chart backdrops;
    # residuals always come from each season's own model).
    models[0] = XevModel(d)
    for s in seasons + [0]:
        g = d if s == 0 else d[d.season == s]
        curves[s] = league_curves(g, models[s])
        dens[s] = density(g)
        # How much of exit velocity does bat speed explain, swing by swing and hitter by hitter?
        hit = g.groupby("batter").agg(n=("bat_speed", "size"), bs=("bat_speed", "mean"), ev=("launch_speed", "mean"))
        hit = hit[hit.n >= MIN_BBE_STATS]
        slope = np.polyfit(hit.bs, hit.ev, 1)[0]
        league[s] = {
            "n_bip": len(g), "n_hitters": int(g.batter.nunique()),
            "bs": r(g.bat_speed.mean(), 2), "ev": r(g.launch_speed.mean(), 2),
            "ps_mean": r(models[s].ps_mean, 2), "ps_coef": r(models[s].ps_coef, 3),
            "r2_swing": r(1 - g.resid.var() / g.launch_speed.var(), 3), "resid_sd": r(g.resid.std(), 2),
            "r_swing": r(g.bat_speed.corr(g.launch_speed), 3),
            "r_hitter": r(hit.bs.corr(hit.ev), 3), "slope_hitter": r(slope, 3),
            "n_hitter_stats": len(hit),
            "sq": r((g.eff >= 0.8).mean(), 4), "eff": r(g.eff.mean(), 4),
            "partial": season_note(s, pd.to_datetime(g.game_date).max().date()) if s else None,
        }
        print(s, league[s])

    h = hitter_table(d, rng, specs)
    h = attach_leaderboards(h)
    h = attach_people(h)
    h = attach_stance(h, d)
    stab = stability(h, d, rng)
    est = estimator_calibration(d, rng)
    print("stability", json.dumps(stab, indent=1))

    drivers = {
        "swing": [
            {"key": c, "label": lab, "desc": desc, "bins": binned_curve(d, c, lo, hi, st)}
            for c, lab, lo, hi, st, desc in SWING_DRIVERS
        ],
        "contact_map": contact_map(d),
        "hitter": hitter_drivers(h),
    }

    keep = ["season", "id", "name", "team", "bats", "n", "bs", "bs_sd", "ev", "xev", "evoe",
            "evoe_raw", "top", "top_raw", "ev90", "eff", "sq", "hh", "la", "ss", "ps", "aa", "ad",
            "tilt", "ix", "iy", "plane", "gap_v", "gap_h", "spray", "xwoba", "lb_bs", "lb_swings",
            "lb_aa", "lb_ad", "lb_tilt", "lb_ideal", "lb_iy", "lb_iy_plate", "lb_stance_y",
            "lb_stance_x", "lb_len", "lb_sq", "lb_blast", "lb_whiff", "lb_fast"]
    h["evoe_se"] = np.sqrt(h.evoe_var)
    keep += ["evoe_se", "evoe_bat", "bat_adj", "bat_len", "bat_oz", "bat_src", "ht", "wt", "wtht", "pos", "st_depth", "st_off", "st_feet", "st_angle"]
    nd = {"n": 0, "season": 0, "id": 0, "lb_swings": 0, "eff": 3, "sq": 3, "hh": 3, "ss": 3,
          "xwoba": 3, "lb_ideal": 3, "lb_sq": 3, "lb_blast": 3, "lb_whiff": 3, "lb_fast": 3,
          "evoe": 2, "evoe_raw": 2, "top": 2, "top_raw": 2, "evoe_se": 2, "evoe_bat": 2, "bat_adj": 2, "ht": 0, "wt": 0, "wtht": 3}
    hitters = []
    for rec in h[keep].to_dict("records"):
        out = {}
        for k, v in rec.items():
            if isinstance(v, str):
                out[k] = v
            elif k in ("n", "season", "id", "lb_swings"):
                out[k] = None if pd.isna(v) else int(v)
            else:
                out[k] = r(v, nd.get(k, 1))
        last, _, first = out["name"].partition(", ")
        out["name"] = f"{first} {last}".strip()
        hitters.append(out)

    meta = {
        "generated": pd.Timestamp.now().isoformat(timespec="minutes"),
        "dataThrough": str(pd.to_datetime(d.game_date).max().date()),
        "seasons": seasons, "league": league, "curves": curves, "density": dens,
        "stability": stab, "shards": N_SHARDS, "minBbeStats": MIN_BBE_STATS,
        "bat": {
            "default": list(DEFAULT_BAT), "q_default": r(float(collision_q(*DEFAULT_BAT)), 4),
            "n_specs": len(specs), "cor": BAT_COR, "ball_oz": BALL_OZ,
            "balance_frac": BALANCE_FRAC, "gyration_frac": GYRATION_FRAC,
        },
        "estimator": est,
        "model": {s: {"knots": models[s].knots.round(2).tolist(), "beta": models[s].beta.round(5).tolist()} for s in models},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    (OUT / "hitters.json").write_text(json.dumps(hitters, separators=(",", ":")))
    (OUT / "drivers.json").write_text(json.dumps(drivers, separators=(",", ":")))
    export_bip(d)
    print(f"wrote {len(hitters):,} hitter rows; data in {OUT}")


if __name__ == "__main__":
    main()
