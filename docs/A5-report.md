# A5 — Experiment Robustness, Saved Replay & WP3 Handoff

## 1. Executive summary

**CONDITIONAL GO A6.** Portable Saved Replay, static HCMC map, independent playback/export, bounded multi-seed/OFAT analysis and read-only WP3 handoff have been implemented. A1–A4.1 regression suites remain PASS. Production Saved was verified with API access isolated; production Live batch was verified against actual local OSRM.

Conditions: retain/report the three seeds rejected by existing Table ETA/snap guards (do not call all requested jobs successful); investigate these before broader experiment claims. Confirm the intended target WP3 branch/HEAD and combined CSS/dependencies/CSP in A6. The audited checkout is a feature branch, not proof of target-main or deployment compatibility. No A6 integration, commit, push or merge performed.

## 2. Git/scope

Preflight root `D:\ThS\VinAI\Phase3_VRIC\gsm-map-sandbox`; branch `feature/a5-experiment-handoff`; HEAD/main `71dd995adb1947028cd32df38626dd6feceda175`. A4.1 commit `9908280` is an ancestor of main. Tracked source/index were clean. Four existing untracked A4.1 evidence files were preserved: dataset-status.json and desktop-1440-overview/desktop-advanced-playing/desktop-advanced-windowed.png.

Per prompt 1.7, Git operations stopped after that inspection; the already-created A5 branch allowed code work without changing branch/index. Final source has intentional uncommitted A5 edits/new files plus those prior untracked files. Final Git status was not rerun under this stop rule; no staging/reset/stash/clean/commit/push/merge occurred. This HEAD/status is explicitly the preflight snapshot.

## 3–4. Preservation and files

Backend mathematical/dispatch/routing core and APIs were not changed. No extraction/preprocessing. Four navigation modes, persistent map, inspector and playback dock remain. Live health/route guards remain for Single Trip/Fleet/Booking; Saved readiness is independent.

| Added | Purpose |
|---|---|
| `frontend/src/lib/artifact.ts` | v1 envelope, canonical SHA, bounded semantic validator, frozen imported payload |
| `frontend/src/lib/replay-assets.ts` | fixed same-origin manifest/assets, byte/hash verification |
| `frontend/src/lib/batch.ts` | deterministic seeds/OFAT jobs, sequential cancellation/cache, statistics/CSV |
| `frontend/src/components/batch-analysis.tsx` | lazy analysis controls/charts/summary/export |
| `frontend/scripts/package-replay.mjs`, `verify-replay.mjs`, `verify-batch.mjs` | reproducible package and actual integration/export checks |
| `scripts/serve_replay.py` | loopback stdlib static host with API rejection |
| `frontend/tests/artifact.test.ts`, `saved-replay.test.ts`, `batch.test.ts` | new regression/security/statistical cases |
| `contracts/*.json`, this report, integration handoff, `docs/evidence/a5/` | manifests, evidence and transfer instructions |

Modified `.gitignore`, README, frontend package scripts, App/App.css, use-voucher, map-style, sandbox-map, voucher-panel/dashboard, ui/map and ui/chart. Worker paths use Vite BASE_URL. Chart sizing uses one ResizeObserver and retains the last positive dimensions when hidden; no new simulation clock/RAF.

## 5–7. Schema, validation and integrity

Authoritative contract: `gsm-voucher-experiment/v1` in `artifact.ts`. Envelope retains the complete existing A4 experiment (config, potential/demand, both plans, routes/events/ledger, financial KPIs/time series, assumptions/provenance) plus schema/model versions, ID/date/fingerprint, asset manifest reference and SHA integrity. Supported model versions: fare-v1, price-response-v1, ledger-v1, paired-v1, dispatch-v1, car/MLD. Unsupported versions fail closed. Existing legacy JSON and five CSV exports remain unchanged; legacy JSON is deliberately not directly importable. Repack it explicitly with the source option.

Import checks 12 MiB size, depth 32, 1M JSON nodes, finite values/safe keys/strings, bounds of config and WGS84, 30 potentials/10 vehicles, bounded events/ledger/routes (200k total points), IDs/references, event ordering/lifecycle timestamps, leg continuity, snapshots, paired inputs, duplicate offer/reservation/settlement, nonnegative finite budget accounting and recomputed final/time-series/comparison metrics. Imported JSON is frozen after validation. Invalid imports retain the last verified session; replacement clears time/selection only after complete validation. URLs/HTML from artifact do not drive resource loading or execution. React escapes displayed strings; CSV protects formula-leading text.

Canonicalization `gsm-json-sorted/v1`: recursively sorted object keys by UTF-16 order, original arrays, ECMAScript JSON numeric/string serialization, UTF-8, no trailing LF. Hash covers the envelope except its integrity block. The **same TS implementation** is bundled for Node packaging and used by browser/round-trip tests; no duplicate Python canonicalizer. Parsed-content hash is insensitive to indentation/CRLF. Manifest ID hashes its content excluding ID; asset SHA hashes raw bytes. A whole-file digest includes volatile metadata; existing A4 experiment identity retains its historical deterministic policy.

SHA consistency is not authentication: a malicious author can recompute a digest. Semantic validation still runs; the reviewed demo digest is additionally recorded in `contracts/demo-artifact-manifest.json`. No arbitrary artifact path/URL is fetched.

## 8–11. Static architecture and actual sample

Saved Runtime is inside Voucher Studio; `?runtime=saved` starts there without any health polling. Map receives no live dataset object in Saved. Five validated GeoJSONs become in-memory MapLibre sources; local fonts/workers are loaded from fixed same-origin paths. A missing/mismatched package is an error, never a fake map. One map instance and existing FleetClock/projections handle playback. Arm switching preserves time; reverse seek reconstructs event-derived state without routing.

`package:replay` copies only verified A1 render assets and installed local fonts/workers, validates/repackages recorded actual A4 local-OSRM default experiment. It does not call OSRM/Osmium or copy PBF/graph. Generated public/replay is ignored. Viewer receives built dist; source checkout alone lacks ignored assets. Package regeneration instructions are in README.

| Package evidence | Value |
|---|---|
| Source experiment | `docs/evidence/a4/default.json`, actual prior local OSRM A4 run |
| Experiment ID | `da5babf709473ce8f527dff8f6ac911484e6745b7583d7c11b39707a32117106` |
| Dataset fingerprint | `9193a3a34bd10f14a21da7121552503971f85419d7241aeb71bc7193eaac3341` |
| Artifact digest | `b4a87ee371f976f12f4da28791dffc66ebeb24352c1d664bf71851eb89c27433` |
| Asset manifest ID | `90b4f4dc0bc8f8021189d67f884f448d05ba57164dfb821593a9baadfe70cd39` |
| Map/font/worker files | 9 files, 8,814,653 bytes (shared module intentionally empty in MapLibre 6.13) |
| Default portable JSON | 412,510 bytes, excluding final LF |
| 10-vehicle portable sample | 380,568 bytes; actual A4 `stress.json`, digest `cdb7e692e224628b29bd9a3d20e37bf45364ce08ed65a233c3072e4a25434193` |

Streets 4,124,871 B; buildings 3,642,002 B; water 229,554 B; green 256,391 B; places 16,117 B. Full per-file hashes, font/worker versions and OSM attribution/ODbL link are in `contracts/replay-asset-manifest.json`. Runtime includes the rest of Vite's generated JS/CSS/UI fonts too; these are carried by dist, not a claim that nine map-package files constitute the whole app.

Static verification origin `127.0.0.1:4173` rejects `/api/*` and all POSTs. Existing FastAPI/OSRM were kept running for others; this server has no proxy and CSP connect-src self excludes their other ports. Manual `/api/health` isolation probe returned 503 (`static-isolation-probe.json`); that operator probe is separately identified, not an application request. Browser resource evidence has no API or external origin calls in Saved. Production Live was separately served at 4174 via Vite preview's inherited loopback backend proxy.

## 12–14. Multi-seed and OFAT methodology

10 seeds default, 30 optional, at most 90 jobs. Seed list deterministically derives from base seed, dataset fingerprint and canonical base config excluding its replaced single-run seed. Each factor group receives the same ordered list. Jobs reuse the existing `/api/voucher-experiment/prepare` core; potential inputs/random draws are shared between A4 arms, never independently resampled by A5. OFAT varies one configured field: alpha .5/1.5/2.5, beta 1/2/3, fixed discount 0/10k/20k VND, budget 0/100k/200k, fleet 3/5/10, preset Low/Medium/High. Discount presets explicitly switch the policy to fixed VND; other factors retain prepared voucher policy.

Sequential requests, 120 s client timeout, AbortController propagation, no retries/substitute seeds. Compact bounded session cache (90) keyed by complete job config, dataset/routing provenance and core version; no route generation in animation frames. Backend already checks disconnect between preparation steps; in-flight OSRM HTTP calls remain bounded by configured server timeout. Cancel is cooperative, not termination of Docker. Closing batch/unmount cancels work; export results before closing because mount-local state/cache are ephemeral.

Statistics use successful paired runs only and expose failed/cancelled/requested counts. Null-bearing wait/utilization/budget measures expose their own valid counts. OFAT **per-group** summaries are the comparison of interest; whole-batch aggregation mixes parameters and repeated seeds and is descriptive, not an independent sample of 21 replications. No bootstrap/CI or empirical causal inference added.

### Mathematical definitions (new A5 formulas)

A4 fare/logistic/dispatch/ledger model is unchanged: see `docs/A4-report.md`. New code is `frontend/src/lib/batch.ts` (`summarizeRuns`); corresponding numerical/null/failure tests are `frontend/tests/batch.test.ts`.

For successful seed s, B/T completed counts are trips, spend S is settled VND. n is successful **paired** count within one configuration group:

\[
\Delta_s=C_{T,s}-C_{B,s},\quad
\overline\Delta=\frac{1}{n}\sum_s\Delta_s,\quad
SD_\Delta=\sqrt{\frac{\sum_s(\Delta_s-\overline\Delta)^2}{n-1}}.
\]

Difference/mean/median/min/max/SD units are trips. SD requires n>1; n=1 returns null SD; n=0 returns null mean/median/min/max. Median is the middle sorted value or mean of two middle values. Empirical distribution retains every successful difference, including zero/negative.

\[
I=\frac{\#\{s:\Delta_s>0\}}n,\quad
CPIC_s=\begin{cases}S_s/\Delta_s&\Delta_s>0\\\text{null}&\Delta_s\le0\end{cases},\quad
CPIC_{pool}=\begin{cases}\sum_sS_s/\sum_s\Delta_s&\sum_s\Delta_s>0\\\text{null}&\text{otherwise}\end{cases}.
\]

I is a dimensionless simulation fraction (null if n=0); CPIC is VND/incremental completed trip. Pooled denominator keeps zero/negative increments. Mean per-run CPIC is not pooled CPIC and is not displayed as it.

\[
\overline S=\frac1n\sum_sS_s,\quad
U_s^{budget}=S_s/Budget_s\quad(Budget_s>0),\quad
\overline{\Delta W}=\frac1{n_W}\sum_{s\in V_W}(W_{T,s}-W_{B,s}).
\]

Mean spend is VND; budget utilization is a ratio with zero-budget runs null. Wait difference is seconds for pairs with both means available; n_W counts those pairs. Fleet utilization difference analogously averages U_T−U_B (dimensionless; ×100 gives percentage points). Empty valid sets return null, not zero. Waiting means inherit A4 picked-up-only definition; occupied/empty distance/utilization are simulation-derived, not GPS observations.

Example fixture (not a research result): differences −1,0,4 and spend 100 VND each give n=3, mean=1, median=0, SD=sqrt(7)=2.646 trips, improvement=1/3, pooled CPIC=300/3=100 VND/trip. Only positive per-run CPIC is 100/4=25, proving why it is different from pooled. Failed runs contribute error records, not invented zeros. Seed variation is conditional simulation uncertainty; routing failures can select the valid subset.

## 15–16. Actual batch results

Final base seed `a5-real-2026`, default A4 config, source fingerprint above. CLI records are `real-batch-none.json/csv` and `real-batch-beta.json/csv` plus summary CSVs. Default: 10 requested, **7 successful / 3 FAIL**, 35.337 s, 10 HTTP prepare requests. Beta OFAT: 10 seeds ×3 values =30 requested, **21 successful / 9 FAIL**, 103.601 s, 30 requests. This is not a 30-seed configuration run. CLI intentionally exits 1 when any job fails.

| Beta | Successful/requested | Mean Δ | Median | Sample SD | Min/max | Improvement fraction |
|---|---|---:|---:|---:|---|---:|
| 1 | 7/10 | .142857 | 0 | .899735 | −1/2 | 1/7 |
| 2 | 7/10 | 3.142857 | 3 | 1.069045 | 2/5 | 7/7 |
| 3 | 7/10 | 4 | 4 | 1.290994 | 2/6 | 7/7 |

Default mean spend 198,945 VND, sum spend 1,392,615 VND, sum increments 22, pooled CPIC 63,300.6818 VND/trip; wait mean difference +21.9280 s, utilization difference +.127218, budget utilization .994725, each valid n=7. Empirical default distribution [2,2,3,3,3,4,5]. Negative increments actually occur at beta=1 and are preserved. They demonstrate capacity/model constraints, not a commercial policy effect.

Seeds `a5-6-d259b2b3`, `a5-7-d890bf2d`, `a5-10-08b8847a` fail with `ROUTER_BAD_RESPONSE: Table ETA/snaps không hợp lệ.` They were not replaced or forced to snap. This is the current strict Table validation boundary; exact subcause was not separately instrumented. Do not claim full seed coverage or unbiased results for all requested seeds. Graph/profile/guard were retained.

## 17–18. Cancellation and export

Actual browser Cancel produced 10 cancelled records and complete=false after aborting the first preparation attempt (`browser-batch-cancel.json`). No fake successes. Client unit tests also cover timeout, sequential concurrency 1, failed progress, wrong provenance, cache separation and cancellation. Subsequent production batch completed with 7 successes/3 errors; browser JSON preserves them and agrees with CLI summary/config/seeds. Live HTTP 502 console entries from these guards are expected error evidence, not uncaught UI exceptions.

Portable browser export was reimported from the exact downloaded file; digest and full payload match. `verify-replay.mjs --browser` independently compares portable envelope, legacy JSON and **all five exact CSV byte strings** to the original Saved plan/export functions: PASS. Batch JSON includes config/seeds/variation/errors/results/summary/groups/model versions/statistical definitions; runs CSV and summary CSV split records and definitions/aggregates. Successful generation count is never substituted for requested count.

## 19–23. Browser, performance, bundle, regressions and network

Real WebGL QA: desktop 1440×900, laptop 1366×768, mobile 390×844; no root horizontal overflow. One canvas after import replacement, navigation collapse/hide/restore and mobile Map/Analytics switching. Saved actual-file import/default demo, 5/10 markers, selection, Play/Pause/Resume/Reset/Seek/custom 1–64, same-time arm comparison, default/advanced charts, comparison table and exports were exercised. At t=500 original Saved metrics reproduce baseline 1/treatment 2 completed and GFV 35,764/74,610 VND. Invalid import leaves controls/session usable.

Live A1 click A/B after keyboard pan returned actual OSRM route (99.5 s), then Play/Pause. A2 generated five real routes (5 total, 1 moving/4 scheduled early); A3 prepared 5/20 scenario and seek to500; A4 prepared paired default. Evidence `regression-single/fleet/booking/voucher.png`. Production Live batch screenshot/JSON verifies the new UI independent of HMR.

Performance evidence `performance.json`: eight production samples (5/10 vehicles ×1/4/32/64; default at1/4, Advanced at32/64), one map each. Means ~16.7–18.1 ms between RAF callbacks, maxima up to266.7 ms on a shared machine; application snapshot publications are capped at30/s. These are **RAF interval samples**, not certified rendering FPS or a controlled CPU benchmark. Charts are viewport-gated; heavy Advanced updates capped at1/s while playing, default4/s. Session clock remains absolute time.

After chart sizing fix, an extra hidden-window sample showed mean779 ms/max1017 ms (`performance-final-chart-fix.json`). Repeating 10/64 Advanced with browser presented gave 1,143 intervals, mean17.00385 ms/max50 ms (`performance-visible-final.json`), no crash. Retain both: hidden-window scheduling/throttling is not a meaningful visible-demo FPS measure; clock still advanced by wall time. No claim of universal60 FPS.

Recharts zero-size warning was observed when hiding mobile Analytics, then fixed by retaining positive observed dimensions; final fresh-mobile console checks are recorded separately. A tab with old lazy chunk URLs crashed after replacing dist in place during QA; reloading the final build resolved it. It was a build-serving/session invalidation issue, not route corruption. Reload after rebuild; atomic releases are an A6 deployment consideration. It is not hidden as a passing stable-runtime sample.

Before build: main1,480.82 kB/gzip422.94, dashboard376.02/gzip110.65, analytics4.74/gzip1.53, CSS152.41/gzip24.78. After: main1,419.28/gzip400.95, shared chart chunk~353.98/gzip104.94, voucher57.27/gzip21.56, artifact24.53/gzip9.20, dashboard24.77/gzip8.17, batch23.79/gzip8.58, analytics4.79/gzip1.55, CSS152.75/gzip24.86. Main decreased through shared chunk splitting, but total lazy code grew; do not describe it as overall bundle reduction. Exact final sizes in build-final.log; Batch only mounts on explicit Advanced/open.

| Check | Result |
|---|---|
| Baseline backend | PASS127, no skipped |
| Baseline frontend | PASS86 |
| Final backend with real-data flag | PASS127, no skipped; existing Starlette deprecation warning |
| Final frontend | PASS125 (86 retained +39 A5), 9 files |
| Typecheck / production build | PASS |
| Lint | PASS exit0 with existing React/vendor warnings; not warning-free |
| Package validation, artifact attack/round-trip guards | PASS |
| Actual Saved production / no API / no external map calls | PASS with isolated server |
| Actual Live batch runner / UI / cancellation | PASS runner behavior; 3/10 jobs FAIL and retained |
| Real beta sensitivity | PASS methodology; 9/30 jobs FAIL and retained |
| A1–A4 browser regression | PASS sampled workflows |
| 5/10 vehicle playback and responsive QA | PASS; performance limits above |
| Full30-seed /90-job run | NOT RUN optional; bounds/seeds unit-tested |
| Target WP3 combined build/deploy | NOT RUN, A6 scope |
| PBF/graph/render integrity | PASS40/40 unchanged |

Resource audit includes same-origin GeoJSON, compiled JS/CSS/local font files, local MapLibre worker/shared module; no sprites/CDN/public map/routing APIs. `static-network*.json`, static server request log and console evidence retain observations. The isolated server's sole intentional `/api/health` request was the manual503 probe. Backend/live errors are reported distinctly. Setup dependencies and Docker pulls were not used during replay; no system software or admin settings changed in A5.

## 24. Protected data

`integrity-before.json`/`integrity-after.json` compare 40 files (three PBF inputs plus all existing routing/render files), bytes+SHA256 unchanged. Inputs before=after:

| PBF | Bytes | SHA256 |
|---|---:|---|
| raw/vietnam-latest.osm.pbf | 330248138 | `2FBD2EE6B4DC151EECF04FA6823CDDF584B47423E190118B10FCE8B6115E9D8A` |
| processed/hcm-q1.osm.pbf | 1321521 | `48B3FD8935B55F65D1A7E4296016A62C36D704B77EE1329F2BA0BEB4F978D3DC` |
| extracted/hcm-center.osm.pbf | 3290221 | `3A939D15AC7B775ABA3F5A0324064CEB3D1B19AB0D176F2B10B94448C36AFDA0` |

Display bbox [106.675,10.750,106.725,10.795]; routing [106.660,10.735,106.740,10.810]. OSRM v5.27.1 car/MLD, digest `855614a38f464b0558a2ad6eaa7cb8c139f39887da9b38b485ce453c6e6e6124`, existing container `gsm-map-osrm` loopback5000 reused.

## 25–26. Handoff/limits

`docs/A5-integration-handoff.md` covers all19 handoff topics; `contracts/a5-handoff-package.json` lists transfer/exclusion/dependency/path/test requirements. Read-only target audit HEAD `6a9db14620299300d23791b6351f0e52c82afc45` found existing NYC campaign and HCM passenger engine/contracts/Pyodide, not an empty WP3 page. Target React19 aligns in major version; Vite7/TS5/no Tailwind/MapLibre/Recharts versus sandbox Vite8/TS6 requires A6 review. Schemas, money/random policies and dataset catalogs must stay separate.

Homogeneous uncalibrated price response, fixed OSM profile duration, small render footprint, no congestion/GPS/real customers/profit/cost model; A1's invalid restrictions/boundary connectivity limitations remain. Three Table-failed seeds constrain complete-cohort claims. Batch state is ephemeral; portable replay has no authenticity signature; non-root hosting/target combined CSS/build remain unverified. No WP1/WP2 model replacement or NYC/Cairo/HCM data pooling.

## 27–29. Windows commands and reproduction

Live commands are preserved in README: check ports/docker first, reuse graph/container, uvicorn loopback8000 + npm dev5173. Production Live QA additionally uses `npm.cmd run preview -- --host 127.0.0.1 --port 4174 --strictPort`; existing Vite config proxies only to local8000. No pipeline needed.

Saved at project root:

```powershell
Set-Location frontend
npm.cmd run package:replay
npm.cmd run verify:replay
npm.cmd run build
Set-Location ..
py -3 scripts\serve_replay.py
# http://127.0.0.1:4173/?runtime=saved
```

Viewer needs a generated dist/static package, not raw PBF/graph. Package default repacks recorded actual A4 run; fresh local experiment instructions use existing prepare API and a **new** response file in README. Optional source flag never overwrites protected OSM artifacts. `node scripts/verify-replay.mjs --browser` verifies captured export evidence; `node scripts/verify-batch.mjs --factor=none` / `--factor=beta` generates actual local experiments and records failures. No dependencies added; two package scripts added, same lockfile/dependency versions.

## 30–31. Next stage and scope confirmation

A6: first confirm target branch/HEAD, review separate HCMC Saved entry/isolated route, resolve/scoped CSS/dependencies/base paths/CSP/licences, copy minimal static package, then run target regression/production offline QA. Consider optional Live service only after that acceptance. Do not infer broad business robustness from the selected successful seeds; diagnose Table failures before wider experiment campaigns.

All code/docs/evidence writes were inside gsm-map-sandbox. Browser export tests used the browser’s normal Downloads location, then copied results into project evidence; those user-facing downloads were not deleted. GSM repository was inspected read-only; no file edited there. Original PBF/manual extract/A1 graph/render protected; existing processes reused. No A6 code, Git mutation, cloud/public service, new system installation or voucher-business causal claim.

## Final validation addendum

Final frontend run after frozen imports, Saved map isolation and batch labels: 125 PASS; typecheck/lint/package/build/export verification exit0. Browser/CLI batch seeds, statuses, increments and aggregate summary match exactly (`batch-browser-cli-audit.json`). Transition from prepared Live to Saved, load demo, Seek500 and Zoom produced zero new API requests and one canvas/five markers (`live-to-saved-resources.json`). Imported payload remains immutable; map and charts consume it successfully. Final screenshots/network/console are separately captured after reload of the last build. Typed event payloads and nullable failure/decision reason strings are checked before publication, preventing malformed JSON objects from reaching text UI fields.

Release evidence: `release-browser-audit.json` / `release-resources.json` capture the final static build after reload: 1 canvas, 10 markers, width/scrollWidth390, no API requests, no external origins and no warning/error logs during that interval. `desktop-release.png`, `desktop-ten-release.png`, `mobile-release.png` and `saved-deliverable.png` show that build. The retained deliverable is the default5 sample at t=500 on the isolated4173 host; temporary QA tabs were closed and viewport override reset.

Final boundary checks also require artifact display bbox to match the trusted static asset manifest and validate numeric/date/request-count metadata. A rehashed artifact claiming the HCM fingerprint for another bbox is rejected. Final frontend total is125; default package digest remains unchanged.

Final production acceptance after the 125-test build: Saved demo at t=500 on 1366×768 shows one MapLibre canvas and five vehicle markers. `final-build-browser-audit.json` records zero API requests, zero external-origin requests and zero new console warnings/errors. `saved-deliverable.png` is the final screenshot. Temporary viewport override was reset; the Saved viewer remains available on loopback port 4173.
