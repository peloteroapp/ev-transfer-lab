"""Download Statcast batted-ball (pitch-level) data, Savant bat-tracking leaderboards, and each
hitter's listed height/weight from the MLB Stats API.

Raw files land in data/raw/ and are cached. Re-running fetches what is missing, plus anything
from the last --refresh-days (Statcast keeps correcting recent games), so a daily in-season run
only re-downloads the current window.

    .venv/bin/python pipeline/fetch_statcast.py                 # 2023 through the current season
    .venv/bin/python pipeline/fetch_statcast.py --seasons 2026  # one season
"""

import argparse
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
SAVANT = "https://baseballsavant.mlb.com"
STATSAPI_PEOPLE = "https://statsapi.mlb.com/api/v1/people"
ROW_CAP = 25_000  # Savant's statcast_search CSV export truncates at this many rows
WINDOW_DAYS = 10
UA = {"User-Agent": "Mozilla/5.0 (batSpeed research pipeline)"}
FIRST_SEASON = 2023  # Hawk-Eye bat tracking starts mid-July 2023


def season_bounds(season: int) -> tuple[date, date]:
    return date(season, 3, 15), date(season, 10, 5)


def latest_season(today: date) -> int:
    return today.year if today >= season_bounds(today.year)[0] else today.year - 1


def get(url: str, retries: int = 4) -> bytes:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - network flakiness, retry everything
            wait = 5 * (attempt + 1)
            print(f"  ! {e} -- retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed after {retries} tries: {url}")


def search_url(season: int, start: date, end: date) -> str:
    params = {
        "all": "true",
        "hfGT": "R|",  # regular season
        "hfPR": "hit\\.\\.into\\.\\.play|",  # balls in play (the only pitches with exit velocity)
        "hfSea": f"{season}|",
        "player_type": "batter",
        "game_date_gt": start.isoformat(),
        "game_date_lt": end.isoformat(),
        "type": "details",
    }
    return f"{SAVANT}/statcast_search/csv?" + urllib.parse.urlencode(params)


def fetch_window(season: int, start: date, end: date, out_dir: Path, stale: bool) -> None:
    out = out_dir / f"{start}_{end}.csv"
    if out.exists() and not stale:
        return
    raw = get(search_url(season, start, end))
    df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig", low_memory=False)
    if len(df) >= ROW_CAP and start < end:
        mid = start + (end - start) // 2
        print(f"  {start}..{end} hit the row cap, splitting")
        fetch_window(season, start, mid, out_dir, stale)
        fetch_window(season, mid + timedelta(days=1), end, out_dir, stale)
        return
    tmp = out.with_suffix(".tmp")
    df.to_csv(tmp, index=False)
    tmp.replace(out)
    print(f"  {start}..{end}: {len(df):,} batted balls")
    time.sleep(1.5)


def fetch_season(season: int, today: date, refresh_days: int) -> None:
    out_dir = RAW / "statcast" / str(season)
    out_dir.mkdir(parents=True, exist_ok=True)
    start, last = season_bounds(season)
    print(f"[{season}] statcast batted balls")
    # Window boundaries never move, so a window still in progress keeps its file name and is simply
    # re-fetched until it is more than refresh_days old.
    while start <= last and start <= today:
        end = min(start + timedelta(days=WINDOW_DAYS - 1), last)
        fetch_window(season, start, end, out_dir, stale=end >= today - timedelta(days=refresh_days))
        start = end + timedelta(days=1)


def fetch_leaderboards(season: int, today: date, refresh_days: int) -> None:
    out_dir = RAW / "leaderboards"
    out_dir.mkdir(parents=True, exist_ok=True)
    common = {
        "dateStart": f"{season}-03-01",
        "dateEnd": f"{season}-11-30",
        "gameType": "Regular",
        "minSwings": "1",
        "minGroupSwings": "1",
        "type": "batter",
        "csv": "true",
    }
    boards = {
        "bat_tracking": ("/leaderboard/bat-tracking", {"seasonStart": "", "seasonEnd": ""}),
        "swing_path": (
            "/leaderboard/bat-tracking/swing-path-attack-angle",
            {"seasonStart": str(season), "seasonEnd": str(season), "groupBy": ""},
        ),
    }
    stale = season_bounds(season)[1] + timedelta(days=10) >= today - timedelta(days=refresh_days)
    for name, (path, extra) in boards.items():
        out = out_dir / f"{name}_{season}.csv"
        if out.exists() and not stale:
            continue
        url = f"{SAVANT}{path}?" + urllib.parse.urlencode({**common, **extra})
        out.write_bytes(get(url).decode("utf-8-sig").encode())
        print(f"[{season}] leaderboard {name}: {out.stat().st_size:,} bytes")
        time.sleep(1.5)


def parse_height(text: str | None) -> float | None:
    """MLB lists height as 6' 7\" -> 79 inches."""
    m = re.match(r"\s*(\d+)'\s*(\d+)?", text or "")
    return int(m.group(1)) * 12 + int(m.group(2) or 0) if m else None


def fetch_people(seasons: list[int]) -> None:
    """Listed (roster) height and weight for every hitter in the batted-ball files. These are the
    current listed values, not measurements by season. Re-fetched in full each run (a few requests)."""
    ids = set()
    for season in seasons:
        for f in (RAW / "statcast" / str(season)).glob("*.csv"):
            ids |= set(pd.read_csv(f, usecols=["batter"]).batter.dropna().astype(int))
    ids = sorted(ids)
    rows = []
    for i in range(0, len(ids), 150):
        chunk = ids[i:i + 150]
        data = json.loads(get(f"{STATSAPI_PEOPLE}?personIds={','.join(map(str, chunk))}"))
        for p in data.get("people", []):
            rows.append({
                "id": p["id"], "name": p.get("fullName"),
                "height_in": parse_height(p.get("height")), "weight_lb": p.get("weight"),
                "birth_date": p.get("birthDate"), "bats": (p.get("batSide") or {}).get("code"),
                "position": (p.get("primaryPosition") or {}).get("abbreviation"),
            })
        time.sleep(0.5)
    out = RAW / "people.csv"
    tmp = out.with_suffix(".tmp")
    pd.DataFrame(rows).to_csv(tmp, index=False)
    tmp.replace(out)
    print(f"people: height/weight for {len(rows):,} of {len(ids):,} hitters")


def main() -> None:
    today = date.today()
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", type=int, nargs="+",
                    default=list(range(FIRST_SEASON, latest_season(today) + 1)))
    ap.add_argument("--refresh-days", type=int, default=7,
                    help="re-fetch windows/leaderboards touching the last N days (0 = only missing files)")
    args = ap.parse_args()
    for season in args.seasons:
        fetch_leaderboards(season, today, args.refresh_days)
        fetch_season(season, today, args.refresh_days)
    fetch_people(args.seasons)
    print("done")


if __name__ == "__main__":
    main()
