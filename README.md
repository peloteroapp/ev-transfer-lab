# EV Transfer Lab

Which MLB hitters turn the same bat speed into more exit velocity, and what their swings do differently. Built to find video of efficient swings for the Pelotero CV project.

## Run it

```bash
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python pipeline/fetch_statcast.py   # ~15 min first time; after that only the last 7 days
.venv/bin/python pipeline/build.py            # ~20 s
python3 -m http.server 8765 --directory web   # open http://localhost:8765
```

- Seasons are picked up automatically, from 2023 through the current one. `--seasons 2026` limits the fetch to one season.
- Each run re-downloads anything from the last 7 days (`--refresh-days`), because Statcast keeps correcting recent games. To re-pull an older season, delete its folder under `data/raw/statcast/`.

## What's in the tool

- **Bat speed vs exit velo**: each hitter's average bat speed against avg EV, EV90, or EV over expected. Dots are colored by EV over expected; click one to open the hitter.
- **Leaderboard**: ranks by EV over expected. Narrow the bat-speed range in the filter bar to rank true same-speed peers. *Peer pct* is the percentile among hitters within ±1.5 mph of average bat speed.
- **Hitter panel**:
  - Every batted ball plotted over the league's 10th/50th/90th percentile EV at each bat speed.
  - "Swings to watch", held to the hitter's typical bat speed.
  - Path metrics compared with same-speed peers, where the top quarter by EV over expected is highlighted.
  - Same-speed comps.
- **Compare**: overlays a comp's swings and pairs matched swings for side-by-side video. Pairs are matched on bat speed, pitch type, pitch speed and location. *Closest hard contact* restricts the comp's side to their own best contact.
- **Watch**: resolves the pitch's play id via the MLB Stats API and opens the Baseball Savant clip.
- **What separates them**: swing-level curves of EV vs expected against each path variable, a face-to-path contact map, hitter-level correlations, and year-to-year stability.

## Bat specs (optional)

Statcast doesn't track bat length or weight, so a heavier bat looks like extra EV over expected. List any known specs in `data/bat_specs.csv`, then re-run `pipeline/build.py`:

```csv
player_id,name,length_in,weight_oz,source
592450,Aaron Judge,35,33,user
,Player Name,34.5,32,where you got it
```

- `player_id` (MLBAM id) is optional. Leave it blank to match on the name exactly as the tool shows it (accents included); the build warns if a name is ambiguous or missing.
- Hitters who aren't listed are assumed to swing a 34 in / 32 oz bat. Change `DEFAULT_BAT` in `pipeline/build.py` if you want a different standard.
- The tool shows **Bat-adj** (EV over expected after removing the bat's estimated effect) in the leaderboard, the scatter tooltip and the hitter panel.
- Model: Nathan's free-bat collision efficiency at the sweet spot (6 in from the tip). The bat shape is scaled by length and calibrated to q ≈ 0.20 for a 34/32 bat. Each batted ball's EV is rescaled by the standard bat's max EV over the hitter's bat's max EV.
- Rough sizes for squared-up contact at 77 mph bat speed and 82 mph pitch speed: 34/33 ≈ +1.2 mph, 35/33 ≈ +0.3, 35/32 ≈ −0.9. Length's lever benefit is already inside the measured bat speed.

## Method (short)

- **Data.** Regular-season balls in play with Hawk-Eye bat tracking (2023 starts mid-July). Bunts are dropped. Savant's competitive-swing rule is applied per hitter-season.
- **xEV.** Fit per season: EV ~ natural spline(bat speed) + pitch speed. **EV over expected** = the hitter's mean (EV − xEV), with empirical-Bayes shrinkage.
- **EV90 over expected.** The hitter's 90th-pct EV minus a hitter-level fit on average bat speed and pitch speed, also shrunk. It is uncorrelated with bat speed by construction.
- **Face-to-path.**
  - Vertical = launch angle − attack angle.
  - Horizontal = spray − attack direction, with pull negative.
  - Plane match = attack angle + vertical approach angle at the plate.

Full notes are in the tool's Method section. Caveat: unless a hitter is listed in `data/bat_specs.csv`, some of their EV over expected may be equipment.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds the data and publishes `web/` to GitHub Pages. It runs:
- on every push to `main`,
- daily at 12:00 UTC from March through October (after Statcast's overnight processing),
- on demand from the Actions tab (**Run workflow**; tick *full refetch* to ignore the cache).

The raw Savant downloads are cached between runs, so an in-season run only re-fetches the last week. If a fetch fails, the job stops and the previous deploy stays live. Generated data (`web/data/`) and raw downloads (`data/raw/`) are not committed.

One-time setup:
1. Create the GitHub repo and push `main`. Pages from a private repo needs a paid GitHub plan; on a free account the repo must be public.
2. In the repo, go to **Settings → Pages → Build and deployment** and set *Source* to **GitHub Actions**.
3. Start the first deploy from **Actions → Build and deploy → Run workflow**, or with the push. The first run downloads every season (~15–20 min). The site lands at `https://<owner>.github.io/<repo>/`.
4. Optional custom domain: in **Settings → Pages → Custom domain**, enter e.g. `lab.pelotero.com`. Then add a DNS CNAME record `lab → <owner>.github.io` and tick *Enforce HTTPS* once the certificate is issued.

To change the refresh schedule, edit the `cron` line in the workflow. To add bat specs, edit `data/bat_specs.csv` and push; the push redeploys.

## Layout

```
pipeline/fetch_statcast.py   Savant downloads -> data/raw/
pipeline/build.py            models + metrics -> web/data/
data/bat_specs.csv           optional bat length/weight per hitter
web/                         static site (D3 7.9.0 vendored)
.github/workflows/deploy.yml build + GitHub Pages deploy
```
