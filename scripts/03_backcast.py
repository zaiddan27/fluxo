"""
Stage 3: Backcast pre-observation per-capita demand using DRT as template
(station-substitution / Maintenance of Variance Extension method, MOVE).

Method
------
For each target municipality M with first observed year y0_M, we have ratio:
    R_M(y) = LPCD_M(y) / LPCD_DRT(y)
across overlap years (y >= y0_M).
The point estimate uses the median R_M across overlap years. For y < y0_M,
    LPCD_M(y) = R_median × LPCD_DRT(y)
    demand_M(y) = LPCD_M(y) × pop_M(y) × 365 / 1000  (m^3/yr)
    mean_monthly_m3(y) = demand_M(y) / 12

Bootstrap CI (1000 iterations): resample the overlap-year ratios with replacement,
recompute backcast, take 5th/95th percentiles for 90% CI.

Confidence flag
---------------
- observed       : taken from raw data
- backcast_high  : >=5 overlap years with DRT AND CV of R <= 0.20
- backcast_mid   : 3-4 overlap years OR CV of R in (0.20, 0.35]
- backcast_low   : <3 overlap years OR CV of R > 0.35  (e.g. Guiguinto: only 2 yrs)

References
----------
- Hirsch (1982) "A comparison of four streamflow record extension techniques"
  Water Resources Research 18(4). The MOVE family of methods.
- WMO (1994) Technical Note No. 175 "Hydrological Network Design".
- Vogel & Stedinger (1985) "Minimum variance streamflow record augmentation
  procedures" WRR 21(5).
"""

from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(r"C:\Users\Lenovo\OneDrive\Pictures\Documents\Fluxo_Elijah")
INT = ROOT / "datasets_processed_bulacan" / "intermediate"
OUT = ROOT / "datasets_processed_bulacan"

RNG = np.random.default_rng(20260512)
N_BOOT = 1000


def confidence_flag(n_overlap, cv_R):
    if n_overlap >= 5 and cv_R <= 0.20:
        return "backcast_high"
    if n_overlap >= 3 and cv_R <= 0.35:
        return "backcast_mid"
    return "backcast_low"


def main():
    df = pd.read_csv(INT / "urban_annual_observed.csv")

    # DRT template LPCD by year (full 2000-2024)
    drt = df[df.municipality == "Dona Remedios Trinidad"].set_index("year")
    drt_lpcd = drt["lpcd"].to_dict()
    drt_years_obs = set(drt[drt.observed].index)

    out_rows = []

    for muni, urban_file in df[["municipality", "urban_file"]].drop_duplicates().itertuples(index=False):
        sub = df[(df.municipality == muni) & (df.urban_file == urban_file)].sort_values("year").copy()
        obs_rows = sub[sub.observed]
        first_obs_year = int(obs_rows["year"].min()) if len(obs_rows) else None

        if muni == "Dona Remedios Trinidad":
            for _, r in sub.iterrows():
                out_rows.append({
                    "municipality": muni, "urban_file": urban_file, "year": int(r.year),
                    "population": r.population,
                    "lpcd_mean": r.lpcd, "lpcd_lower90": r.lpcd, "lpcd_upper90": r.lpcd,
                    "annual_m3_mean": r.annual_m3,
                    "annual_m3_lower90": r.annual_m3, "annual_m3_upper90": r.annual_m3,
                    "mean_monthly_m3": r.annual_m3 / 12.0 if pd.notna(r.annual_m3) else np.nan,
                    "flag": "observed", "n_overlap_years": np.nan, "cv_ratio": np.nan,
                })
            continue

        overlap_years = [y for y in obs_rows["year"] if y in drt_years_obs]
        ratios = []
        for y in overlap_years:
            l_m = float(obs_rows.loc[obs_rows.year == y, "lpcd"].iloc[0])
            l_d = drt_lpcd.get(y, np.nan)
            if pd.notna(l_m) and pd.notna(l_d) and l_d > 0:
                ratios.append(l_m / l_d)
        ratios = np.array(ratios, dtype=float)
        if len(ratios) == 0:
            R_med, R_cv = np.nan, np.nan
        else:
            R_med = float(np.median(ratios))
            R_cv = float(np.std(ratios) / np.mean(ratios)) if np.mean(ratios) > 0 else np.nan

        flag_default = confidence_flag(len(ratios), R_cv if pd.notna(R_cv) else 999)

        for _, r in sub.iterrows():
            y = int(r.year)
            if r.observed:
                lpcd_mean = r.lpcd
                lpcd_lo = lpcd_hi = r.lpcd
                annual_mean = r.annual_m3
                annual_lo = annual_hi = r.annual_m3
                flag = "observed"
            else:
                # Backcast: LPCD_M(y) = R * LPCD_DRT(y); demand = LPCD * pop * 365 / 1000
                l_d = drt_lpcd.get(y, np.nan)
                pop = r.population
                if pd.isna(l_d) or pd.isna(R_med) or pd.isna(pop):
                    lpcd_mean = lpcd_lo = lpcd_hi = np.nan
                    annual_mean = annual_lo = annual_hi = np.nan
                else:
                    lpcd_mean = R_med * l_d
                    # Bootstrap CI on R
                    boot_R = RNG.choice(ratios, size=(N_BOOT, len(ratios)), replace=True).mean(axis=1) \
                             if len(ratios) > 0 else np.array([R_med])
                    boot_lpcd = boot_R * l_d
                    lpcd_lo = float(np.quantile(boot_lpcd, 0.05))
                    lpcd_hi = float(np.quantile(boot_lpcd, 0.95))
                    annual_mean = lpcd_mean * pop * 365.0 / 1000.0
                    annual_lo = lpcd_lo * pop * 365.0 / 1000.0
                    annual_hi = lpcd_hi * pop * 365.0 / 1000.0
                flag = flag_default

            out_rows.append({
                "municipality": muni, "urban_file": urban_file, "year": y,
                "population": r.population,
                "lpcd_mean": lpcd_mean,
                "lpcd_lower90": lpcd_lo, "lpcd_upper90": lpcd_hi,
                "annual_m3_mean": annual_mean,
                "annual_m3_lower90": annual_lo, "annual_m3_upper90": annual_hi,
                "mean_monthly_m3": annual_mean / 12.0 if pd.notna(annual_mean) else np.nan,
                "flag": flag, "n_overlap_years": len(ratios),
                "cv_ratio": R_cv,
            })

    out_df = pd.DataFrame(out_rows).sort_values(["urban_file", "municipality", "year"]).reset_index(drop=True)
    out_path = OUT / "urban_annual_imputed.csv"
    out_df.to_csv(out_path, index=False)

    print(f"Wrote {out_path}")
    print(f"Total rows: {len(out_df):,}")
    print()
    print("=== Flag counts ===")
    print(out_df["flag"].value_counts().to_string())
    print()
    print("=== Per-muni confidence summary (only munis with backcasts) ===")
    flagged = out_df[out_df["flag"] != "observed"]
    if len(flagged) > 0:
        summary = (
            flagged.groupby(["municipality"]).agg(
                n_backcast_years=("year", "count"),
                first_year=("year", "min"),
                last_year=("year", "max"),
                flag=("flag", "first"),
                n_overlap=("n_overlap_years", "first"),
                cv_ratio=("cv_ratio", "first"),
            ).round(3).reset_index().sort_values("cv_ratio")
        )
        print(summary.to_string(index=False))


if __name__ == "__main__":
    main()
