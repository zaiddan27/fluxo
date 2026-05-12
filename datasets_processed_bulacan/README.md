# Bulacan urban water demand — gap-filled dataset

This folder contains gap-filled annual and monthly water-demand estimates for
22 Bulacan municipalities/cities, 2000-2024. Built from the raw data in
`datasets_raw_bulacan/urban/` (which has 5-23 year gaps for most municipalities)
plus auxiliary census/water-district data in `datasets_auxiliary_bulacan/`.

Read `METHODOLOGY.md` before using these values in any analysis.

## Files

| File | Rows | Purpose |
|---|---|---|
| `urban_annual_imputed.csv` | 550 | One row per municipality-year. Mean + 90% CI for both LPCD and annual m³. **Primary output.** |
| `urban_monthly_broadcast.csv` | 6,600 | The annual values broadcast across 12 months to match the input file format. Use this if you need a drop-in replacement for the raw monthly CSVs. |
| `urban_validation_metrics.csv` | 122 | Hold-out validation predictions (the basis for the CI calibration). One row per (experiment, muni, held-out-year). |
| `intermediate/urban_long_raw.csv` | 6,600 | Stage 1 intermediate — raw long-format with observed flag. |
| `intermediate/urban_annual_observed.csv` | 550 | Stage 2 intermediate — annual averages + interpolated population + observed LPCD. |

## Quick read of confidence flags

Each backcast row has a `flag`:

| Flag | Count | What it means |
|---|---|---|
| `observed` | 373 | Taken directly from raw data (de-staircased). Use freely. |
| `backcast_high` | 57 | High confidence. Empirical 90% predictive interval on validation: [-21%, +34%]. Coverage: 86%. **Use with normal caution.** |
| `backcast_mid` | 70 | Medium confidence. Empirical interval: [-13%, +121%]. Asymmetric — values may be substantially under-estimated. |
| `backcast_low` | 50 | Low confidence. Empirical interval: [+15%, +215%]. **Point estimate is a lower bound only** — true demand is almost certainly higher. Driven by peri-Manila munis (Marilao, Meycauayan, Bulakan, Obando) whose growth diverged sharply from the rural template. |

## Big honest caveats

1. **The raw "monthly" data is not really monthly.** It's annual values
   broadcast across 12 months. This dataset preserves that property in
   `urban_monthly_broadcast.csv` for compatibility, but no real monthly
   seasonality exists.

2. **The DRT-as-template method systematically under-estimates peri-urban
   demand.** Validation showed this clearly. If you need accurate values for
   Marilao, Meycauayan, Bulakan, San Jose del Monte, or Obando pre-2010, this
   dataset will not give them to you. The flag is honest about this.

3. **The "backcast" values for water districts that may not have existed in
   2000 are still produced** (per the user's request to mark low-confidence
   instead of leaving NaN). The 4 districts we confirmed pre-2000 are
   Norzagaray (1986), Bulakan (1989), Bocaue (1979), Obando (1978). For the
   rest the establishment date is unverified — treat backcast values for
   those as model output, not historical record.

4. **Population is linearly interpolated between census years.** That introduces
   small but real error in inter-census years. Less than 1% per year typically.

## Reproduce

```powershell
cd C:\Users\Lenovo\OneDrive\Pictures\Documents\Fluxo_Elijah
python scripts/01_load_urban.py
python scripts/02_annualize_and_per_capita.py
python scripts/03_backcast.py
python scripts/04_validate.py
python scripts/05_calibrate_ci.py
```

All scripts are deterministic (RNG seeded with `20260512`).
