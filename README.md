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
- **Height, weight and the swing**:
  - A correlation matrix of listed height, weight, and weight ÷ height (pounds per inch) against bat speed, avg EV, EV90 and EV over expected. Click a cell to plot that pair.
  - A scatter with a straight-line fit. Dots are colored by how far each hitter sits above or below the line, and 2+ SD outliers are outlined and labeled.
  - Outlier tables ranking who gets more and less than their size predicts.
  - The leaderboard's **Body** columns add *Spd vs size* and *EV vs size*: residuals from height and weight together.
  - Everything follows the filter bar.
- **Batting stance**: Savant's Hawk-Eye stance (measured 1 s before release): depth in the box, distance off the plate, foot separation, and stance angle (negative = open).
  - The same layout as the body section, against bat speed and EV over expected: correlation matrix, scatter with flagged outliers, and over/under-performer tables.
  - Plus the most extreme stances each way (widest/narrowest, most open/closed, and so on), with each hitter's outcomes and percentiles.
  - The summary checks the strongest stance link against height.
  - The leaderboard's **Stance** columns and the hitter panel's stance tag show each hitter's setup.
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

- **Batting stance.** Savant's batting stance export per season (`data/raw/leaderboards/batting_stance_{season}.csv`). Only `seasonStart`/`seasonEnd` filter it, and `minSwings=1` is needed for every hitter rather than qualifiers. Switch hitters' two sides are averaged by batted balls.
- **Height and weight.** Listed roster values from the MLB Stats API (`data/raw/people.csv`, refreshed on every fetch). There is one current value per hitter, not a measurement by season.

Full notes are in the tool's Method section. Caveat: unless a hitter is listed in `data/bat_specs.csv`, some of their EV over expected may be equipment.

## Deploy (Cloudflare)

The site is served by Cloudflare as static assets: `wrangler.jsonc` points at `web/`, and there is no Worker code. It's live at https://ev-transfer-lab.bat-peed.workers.dev.

**Deploy by hand** (after a build):

```bash
.venv/bin/python pipeline/fetch_statcast.py && .venv/bin/python pipeline/build.py
npx wrangler@4 deploy
```

Run `npx wrangler@4 login` first if Wrangler isn't signed in on this machine.

**Automatic refresh.** `.github/workflows/deploy.yml` fetches, builds and deploys. It runs on every push to `main`, daily at 12:00 UTC from March through October, and on demand from the Actions tab (tick *full refetch* to ignore the cached raw data). Raw downloads are cached between runs, so an in-season run only re-fetches the last week; if a fetch fails, the live site stays as it was. It needs two repo secrets, set in **Settings → Secrets and variables → Actions**:
- `CLOUDFLARE_API_TOKEN`: create it in the Cloudflare dashboard under **My Profile → API Tokens → Create Token**, using the *Edit Cloudflare Workers* template.
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers & Pages overview page.

GitHub Actions on the `peloteroapp` account was blocked by a billing lock on 2026-10-16, so until that clears, deploy by hand.

**Custom domain.** In the Cloudflare dashboard, open **Workers & Pages → ev-transfer-lab → Settings → Domains & Routes → Add → Custom domain** (e.g. `lab.pelotero.com`; the domain's DNS must be on Cloudflare). The account's `workers.dev` subdomain (`bat-peed`) can be renamed under **Workers & Pages → Account details**.

To change the refresh schedule, edit the `cron` line in the workflow. To add bat specs, edit `data/bat_specs.csv`, then rebuild and deploy (or push).

## Layout

```
pipeline/fetch_statcast.py   Savant downloads (incl. batting stance) + MLB height/weight -> data/raw/
pipeline/build.py            models + metrics -> web/data/
data/bat_specs.csv           optional bat length/weight per hitter
web/                         static site (D3 7.9.0 vendored); traits.js powers the body and stance sections
wrangler.jsonc               Cloudflare static-assets config (serves web/)
.github/workflows/deploy.yml scheduled build + Cloudflare deploy
```
