"""
Stage 4: Validation by hold-out experiment.

For each muni with a long observed record, we mask its early years, treat them
as if they were missing, run the same backcast procedure, and compare predicted
vs. observed.

Strategy
--------
Two experiments:

1. DRT cross-validation. DRT is the template, so we can't use the standard
   procedure on it. Instead we use a leave-one-year-out CV: for each year y in
   DRT 2000-2024, hide it, fit a simple log-linear LPCD model to the remaining
   24 years, predict y. Reports overall MAPE on DRT itself - a sanity check
   that DRT's own trajectory is internally consistent.

2. Held-out muni backcast. For munis with observations starting at 2005-2006
   (Balagtas, City of Malolos, Meycauayan, SJDM, Santa Maria, San Ildefonso,
   San Miguel, Bulacan, San Rafael, Obando), we artificially restrict their
   observation window to 2015+ only, then backcast 2005-2014 using the same
   procedure. Compare predicted to truly-observed 2005-2014 values.

Outputs
-------
    datasets_processed_bulacan/urban_validation_metrics.csv
    columns: experiment, municipality, year, true_annual_m3, pred_annual_m3,
             pred_lower90, pred_upper90, abs_error, pct_error, covered_by_ci
"""

from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(r"C:\Users\Lenovo\OneDrive\Pictures\Documents\Fluxo_Elijah")
INT = ROOT / "datasets_processed_bulacan" / "intermediate"
OUT = ROOT / "datasets_processed_bulacan"

RNG = np.random.default_rng(20260512)
N_BOOT = 1000


def backcast_one(target_obs, drt_obs, target_pop_by_year, target_first_obs_year, drt_lpcd_by_year):
    """Replay the same backcast logic from stage 3, given filtered observed data."""
    overlap = [y for y in target_obs.index if y in drt_obs.index]
    ratios = []
    for y in overlap:
        l_m = target_obs.loc[y, "lpcd"]
        l_d = drt_obs.loc[y, "lpcd"]
        if pd.notna(l_m) and pd.notna(l_d) and l_d > 0:
            ratios.append(l_m / l_d)
    ratios = np.array(ratios, dtype=float)
    if len(ratios) == 0:
        return None
    R_med = float(np.median(ratios))
    preds = {}
    for y in range(2000, target_first_obs_year):
        l_d = drt_lpcd_by_year.get(y)
        pop = target_pop_by_year.get(y)
        if l_d is None or pop is None or pd.isna(l_d) or pd.isna(pop):
            continue
        lpcd_mean = R_med * l_d
        boot_R = RNG.choice(ratios, size=(N_BOOT, len(ratios)), replace=True).mean(axis=1)
        boot_lpcd = boot_R * l_d
        annual_mean = lpcd_mean * pop * 365.0 / 1000.0
        annual_lo = float(np.quantile(boot_lpcd, 0.05)) * pop * 365.0 / 1000.0
        annual_hi = float(np.quantile(boot_lpcd, 0.95)) * pop * 365.0 / 1000.0
        preds[y] = (annual_mean, annual_lo, annual_hi)
    return preds


def main():
    df = pd.read_csv(INT / "urban_annual_observed.csv")
    drt = df[df.municipality == "Dona Remedios Trinidad"].set_index("year")
    drt_obs = drt[drt.observed]
    drt_lpcd_full = drt_obs["lpcd"].to_dict()

    rows = []

    # Experiment 1 - DRT LOO log-linear CV
    drt_arr = drt_obs.reset_index()
    for i, r in drt_arr.iterrows():
        y_test = int(r.year)
        train = drt_arr[drt_arr.year != y_test]
        # log-linear fit on LPCD
        x = train["year"].values.astype(float)
        ylog = np.log(train["lpcd"].values.astype(float))
        # OLS
        a, b = np.polyfit(x, ylog, 1)
        pred_lpcd = float(np.exp(a * y_test + b))
        pred_annual = pred_lpcd * float(r.population) * 365.0 / 1000.0
        true_annual = float(r.annual_m3)
        err = pred_annual - true_annual
        pct = err / true_annual * 100.0
        rows.append({
            "experiment": "DRT_LOO_loglinear",
            "municipality": "Dona Remedios Trinidad",
            "year": y_test,
            "true_annual_m3": true_annual,
            "pred_annual_m3": pred_annual,
            "pred_lower90": np.nan, "pred_upper90": np.nan,
            "abs_error": abs(err), "pct_error": pct,
            "covered_by_ci": np.nan,
        })

    # Experiment 2 - hold out early years for munis whose first obs is 2005-2006
    candidates = (
        df[df.observed & (df.year <= 2006)]
        .groupby("municipality").agg(first_obs=("year", "min"))
        .reset_index()
    )
    candidates = candidates[candidates.municipality != "Dona Remedios Trinidad"]
    HOLDOUT_FROM = 2015  # use only 2015+ as "observed", predict 2005-2014

    for muni in candidates["municipality"]:
        sub = df[(df.municipality == muni) & df.observed].set_index("year")
        target_obs_full = sub
        target_obs_restricted = sub[sub.index >= HOLDOUT_FROM]
        if len(target_obs_restricted) < 5:
            continue
        true_obs_holdout = sub[(sub.index < HOLDOUT_FROM)]
        if len(true_obs_holdout) == 0:
            continue
        target_pop_by_year = sub["population"].to_dict()
        # extend pop dict for early years too via interp from raw csv
        full_pop = df[(df.municipality == muni)].set_index("year")["population"].to_dict()
        preds = backcast_one(
            target_obs=target_obs_restricted,
            drt_obs=drt_obs,
            target_pop_by_year=full_pop,
            target_first_obs_year=HOLDOUT_FROM,
            drt_lpcd_by_year=drt_lpcd_full,
        )
        if preds is None:
            continue
        for y in true_obs_holdout.index:
            if y not in preds:
                continue
            mean, lo, hi = preds[y]
            true_val = float(true_obs_holdout.loc[y, "annual_m3"])
            err = mean - true_val
            covered = bool(lo <= true_val <= hi)
            rows.append({
                "experiment": "muni_holdout_2005to2014",
                "municipality": muni,
                "year": int(y),
                "true_annual_m3": true_val,
                "pred_annual_m3": mean,
                "pred_lower90": lo, "pred_upper90": hi,
                "abs_error": abs(err),
                "pct_error": err / true_val * 100.0 if true_val > 0 else np.nan,
                "covered_by_ci": covered,
            })

    out_df = pd.DataFrame(rows)
    out_df.to_csv(OUT / "urban_validation_metrics.csv", index=False)

    print(f"Wrote {OUT / 'urban_validation_metrics.csv'}")
    print()
    print("=== Experiment 1: DRT LOO log-linear ===")
    drt_v = out_df[out_df.experiment == "DRT_LOO_loglinear"]
    print(f"  N = {len(drt_v)}")
    print(f"  MAPE = {drt_v['pct_error'].abs().mean():.1f}%")
    print(f"  Median |pct_error| = {drt_v['pct_error'].abs().median():.1f}%")
    print(f"  RMSE (m^3/yr) = {np.sqrt((drt_v['abs_error']**2).mean()):,.0f}")
    print()
    print("=== Experiment 2: Per-muni hold-out 2005-2014 ===")
    m_v = out_df[out_df.experiment == "muni_holdout_2005to2014"]
    print(f"  N = {len(m_v)} predictions across {m_v['municipality'].nunique()} munis")
    print(f"  MAPE = {m_v['pct_error'].abs().mean():.1f}%")
    print(f"  Median |pct_error| = {m_v['pct_error'].abs().median():.1f}%")
    print(f"  90% CI coverage = {m_v['covered_by_ci'].mean()*100:.1f}%  (target: 90%)")
    print()
    print("  Per-muni breakdown:")
    per_muni = m_v.groupby("municipality").agg(
        n=("year", "count"),
        mape=("pct_error", lambda s: s.abs().mean()),
        coverage=("covered_by_ci", lambda s: s.mean() * 100),
    ).round(1).reset_index().sort_values("mape")
    print(per_muni.to_string(index=False))


if __name__ == "__main__":
    main()
