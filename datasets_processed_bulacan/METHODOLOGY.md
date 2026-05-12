# Methodology — Bulacan urban water demand backcasting

## Problem statement

Five raw CSV/xlsx files (`datasets_raw_bulacan/urban/`) report water demand in
m³ for 22 Bulacan municipalities, monthly, 2000-01 to 2024-12. Only one
municipality (Doña Remedios Trinidad, "DRT") has data starting in 2000.
The other 21 series begin somewhere between 2005 and 2023, leaving gaps
of 5-23 years that we want to fill defensibly.

## Data inspection that changed our approach

Initial assumption: monthly observations with leading NaN gaps. Inspection
revealed something different: within each year, **all 12 monthly values are
identical or near-identical**. The reported "monthly" figures are annual
values broadcast across 12 months. There is no genuine intra-annual variation
in the data.

This means:
- The natural unit of observation is one annual figure per municipality-year.
- Imputation should produce annual figures, not monthly ones.
- Any "monthly" output is just the annual figure ÷ 12 broadcast back.

We work with annual figures internally and broadcast at the final step for
output compatibility.

## Method — Station-substitution (MOVE family)

### Why this method

Three constraints shaped the choice:

1. **One long-record station, many short-record stations.** This is the
   classic "record extension" setup in hydrology. Methods designed for it
   include MOVE.1 / MOVE.2 / MOVE.3 (Hirsch 1982; Vogel & Stedinger 1985),
   MOVE.4 (Vogel & Stedinger 1985), and Bayesian variants.

2. **The underlying signal is per-capita demand × population**, not raw demand.
   Per-capita demand changes more slowly than raw demand; population changes
   monotonically and is independently observed (census). Decomposing demand
   into these two factors is standard in urban water planning (IWA Best
   Practice 2016; ADB Philippines Water Sector Assessment 2013).

3. **Validation must drive uncertainty.** Bootstrap-on-ratios under-states
   uncertainty (it doesn't capture model risk). Empirical hold-out calibration
   is standard in ensemble forecasting (Gneiting & Raftery 2007).

### Pipeline

#### Stage 1 — Load (`scripts/01_load_urban.py`)
Read 4 CSVs + 1 xlsx. Handle BOM, varying metadata rows, leading semicolons,
two-row header in San Miguel xlsx. Melt to long format
`(year, month, municipality, urban_file, demand_m3, observed)`.

#### Stage 2 — Annualize (`scripts/02_annualize_and_per_capita.py`)
For each (muni, year), average the 12 monthly values to get one annual figure
(mean preserves meaning if there is a mid-year change, which is rare).
Multiply by 12 to get annual m³. Merge with population (linear interpolation
between 1990, 2000, 2010, 2015, 2020, 2024 census points from PSA via
`citypopulation.de`). Compute:
```
LPCD = annual_m3 × 1000 L/m³ / (population × 365 days)
```

#### Stage 3 — Backcast (`scripts/03_backcast.py`)
For each target municipality M with first observed year y₀:

```
1. Overlap years O = {years where both M and DRT have observed LPCD}
2. Ratios R_y = LPCD_M(y) / LPCD_DRT(y)  for each y in O
3. Point estimate: R̂ = median(R_y)
4. For y < y₀:
     LPCD_M(y)   = R̂ × LPCD_DRT(y)
     annual_M(y) = LPCD_M(y) × pop_M(y) × 365 / 1000
5. Bootstrap CI: resample R_y with replacement 1000×,
     recompute LPCD bounds (5th, 95th percentiles).
```

DRT is used as-is (it is the template — backcasting it on itself would be
circular).

Confidence tier assigned from overlap count and ratio coefficient-of-variation:

| Tier | Condition |
|---|---|
| `backcast_high` | ≥5 overlap years AND CV(R) ≤ 0.20 |
| `backcast_mid` | 3-4 overlap years OR 0.20 < CV(R) ≤ 0.35 |
| `backcast_low` | <3 overlap years OR CV(R) > 0.35 |

#### Stage 4 — Validate (`scripts/04_validate.py`)

Two hold-out experiments:

**(a) DRT leave-one-out**: For each year y in DRT, fit a log-linear
LPCD-vs-year on the other 24 years, predict y, measure absolute % error.
Result: MAPE = 15%, median = 11%. Sanity check that DRT's own series is
internally consistent.

**(b) Per-muni hold-out**: For 10 munis with observations starting 2005-2006,
artificially restrict their observed window to 2015+, then run the stage-3
backcast and compare predicted 2005-2014 values to truly-observed ones.
Result: MAPE = 30% overall; per-muni MAPE ranges 8-44%.

This (b) is the **honest accuracy of the method**.

#### Stage 5 — Calibrate CI (`scripts/05_calibrate_ci.py`)

The stage-3 bootstrap CI only covered 11% of hold-out validation cases
(target 90%). The bootstrap captures variability in R within the observed
period — but not the dominant source of error, which is **divergence of the
target muni's per-capita trajectory from DRT's template trajectory**.

Fix: empirical calibration. From the stage-4 validation residuals, compute
per-tier the 5th and 95th quantiles of the relative position of *true* values
around predictions:

```
true_over_pred_rel = (true - pred) / pred
```

Then for each backcast row, the 90% CI on `annual_m3_mean` becomes:

```
lower = mean × (1 + q05_of_tier)
upper = mean × (1 + q95_of_tier)
```

Take the wider of (empirical, bootstrap) bounds.

Per-tier empirical 90% intervals (from validation):

| Tier | n_validation | 90% interval | In-sample coverage |
|---|---|---|---|
| `backcast_high` | 29 | [-21%, +34%] | 86% |
| `backcast_mid` | 40 | [-13%, +121%] | 90% |
| `backcast_low` | 28 | [+15%, +215%] | 86% |

The asymmetric, positive-skewed intervals for mid/low tiers reflect a real
finding: the rural-DRT template systematically under-estimates peri-urban
demand. The CI honestly captures this — for low-tier munis, the point estimate
is effectively a lower bound and the true 2000-2010 demand could be ~3× higher.

## Why not other methods

| Method | Why rejected for this dataset |
|---|---|
| Linear / spline interpolation | No data to interpolate *between* for the leading gap. |
| ARIMA / SARIMA backcasting | Needs a long observed series in the target itself. Most targets only have 9-19 yrs. |
| Kalman / state-space (imputeTS) | Same as ARIMA — needs in-target signal. |
| MICE / MICE-RF | Assumes MAR — but missingness here is structurally early-period, not random. |
| MissForest | Same MAR assumption issue. |
| Bayesian hierarchical (PyMC) | Stronger choice, would have been preferred if peri-urban municipalities had a long-record counterpart. With only one long-record (DRT, rural), hierarchical pooling adds shrinkage but not new information. |
| Direct Sampling (Mariethoz et al.) | Multiple-point geostatistics — designed for stochastic intra-year reconstruction. Overkill here since the data lacks intra-year variation by construction. |

## Limitations we cannot resolve with available data

1. **One long-record station.** DRT is rural; using it as template biases
   peri-urban backcasts low. Resolving this requires another long-record series
   from a peri-urban Bulacan municipality (e.g., from LWUA FOI request).

2. **No infrastructure-rollout dates.** Some series may start at 2010 because
   the water district was created / expanded / began metering then. The
   backcast assumes water demand existed in 2000 at scaled-DRT levels, but if
   the district was actually founded in 2008, the 2000-2007 backcast is for
   nonexistent infrastructure. Establishment dates confirmed for only 4 of 22
   districts (see `datasets_auxiliary_bulacan/bulacan_water_districts.csv`).

3. **"Demand" = billed consumption ≠ actual water use.** Pre-meter-coverage
   demand is fundamentally a different quantity. Backcasting "demand" backward
   into a low-coverage era projects a metric that didn't really exist in the
   same form.

## References

- **Hirsch, R.M. (1982).** A comparison of four streamflow record extension
  techniques. *Water Resources Research* 18(4): 1081-1088.
- **Vogel, R.M., Stedinger, J.R. (1985).** Minimum variance streamflow record
  augmentation procedures. *Water Resources Research* 21(5): 715-723.
- **WMO (1994).** *Technical Note No. 175 — Hydrological Network Design.*
  World Meteorological Organization.
- **Gneiting, T., Raftery, A.E. (2007).** Strictly proper scoring rules,
  prediction, and estimation. *JASA* 102(477): 359-378.
- **van Buuren, S. (2018).** *Flexible Imputation of Missing Data* (2nd ed.).
  CRC Press. (For MICE methodology context.)
- **Stekhoven, D.J., Bühlmann, P. (2012).** MissForest — non-parametric
  missing value imputation for mixed-type data. *Bioinformatics* 28(1).
- **Mariethoz, G. et al. (2018).** Gap-filling of daily streamflow time series
  using Direct Sampling. *Journal of Hydrology* 569: 573-586.
- **PIDS (1999).** *Determination of Basic Household Water Requirements.*
  Discussion Paper Series 99-02. https://pidswebs.pids.gov.ph/CDN/PUBLICATIONS/pidsdps9902.pdf
- **ADB (2013).** *Philippines: Water Supply and Sanitation Sector
  Assessment.* https://www.adb.org/sites/default/files/institutional-document/33810/files/philippines-water-supply-sector-assessment.pdf
- **Project CCHAIN (2024).** Open, validated, health-climate-environment-
  socioeconomic dataset for 12 Philippine cities, 2003-2022.
  https://data.humdata.org/dataset/project-cchain

## Data sources

- **Raw water demand**: `datasets_raw_bulacan/urban/` (provided)
- **Population**: PSA Census 1990-2024 via citypopulation.de
  (`datasets_auxiliary_bulacan/bulacan_population_census.csv`)
- **Water district establishment**: LWUA water district pages, FOI Philippines
  (`datasets_auxiliary_bulacan/bulacan_water_districts.csv`)
- **Per-capita demand reference**: PIDS 1999, NWRB 2004, LWUA standards
  (`datasets_auxiliary_bulacan/ph_per_capita_water_reference.csv`)
