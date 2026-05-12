"""
Stage 5: Calibrate the CI per-confidence-tier using empirical predictive errors
from the hold-out validation.

Pooled-empirical calibration treats all backcasts as drawing from one error
distribution, which masks the real heterogeneity. We instead calibrate the CI
PER CONFIDENCE TIER:

  Tier        | Stage-3 flag      | Calibration source
  ----------- | ----------------- | -------------------------------------------
  high        | backcast_high     | Validation rows of high-tier munis
  mid         | backcast_mid      | Validation rows of mid-tier munis
  low         | backcast_low      | Validation rows of low-tier munis

For munis in the validation set, we use their own tier's empirical 5/95
quantiles of relative error. For tiers with no validation rows, we widen by
a conservative factor (50% one-sided).
"""

from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(r"C:\Users\Lenovo\OneDrive\Pictures\Documents\Fluxo_Elijah")
OUT = ROOT / "datasets_processed_bulacan"


def main():
    imp = pd.read_csv(OUT / "urban_annual_imputed.csv")
    val = pd.read_csv(OUT / "urban_validation_metrics.csv")
    val = val[val.experiment == "muni_holdout_2005to2014"].copy()
    # The CI we want is: "given a pred, where is true likely to be?"
    # So use (true - pred) / pred so that  true = pred * (1 + that_quantity).
    val["true_over_pred_rel"] = (val["true_annual_m3"] - val["pred_annual_m3"]) / val["pred_annual_m3"]

    # Tag each validation row with the imp's flag for that muni
    muni_to_flag = imp[imp.flag.str.startswith("backcast")].groupby("municipality")["flag"].first().to_dict()
    val["flag"] = val["municipality"].map(muni_to_flag).fillna("backcast_mid")

    # Per-tier 5/95 quantiles of relative error
    tiers = {}
    for tier in ["backcast_high", "backcast_mid", "backcast_low"]:
        rows = val[val.flag == tier]
        if len(rows) >= 5:
            q05 = float(np.quantile(rows["true_over_pred_rel"], 0.05))
            q95 = float(np.quantile(rows["true_over_pred_rel"], 0.95))
        else:
            # Fallback: use conservative dispersion
            q05, q95 = -0.5, 0.5
        tiers[tier] = (q05, q95)
        print(f"  {tier:15s}: n={len(rows):3d}  90% predictive interval = [{q05:+.1%}, {q95:+.1%}]")
    print()

    # Apply per-tier calibration to backcast rows; keep observed as-is
    def calibrate(row):
        if row["flag"] == "observed":
            return row["annual_m3_lower90"], row["annual_m3_upper90"]
        if pd.isna(row["annual_m3_mean"]):
            return np.nan, np.nan
        q05, q95 = tiers.get(row["flag"], (-0.5, 0.5))
        m = row["annual_m3_mean"]
        emp_lo, emp_hi = m * (1 + q05), m * (1 + q95)
        # Wider of empirical vs bootstrap
        bs_lo = row.get("annual_m3_lower90", np.nan)
        bs_hi = row.get("annual_m3_upper90", np.nan)
        lo = min(emp_lo, bs_lo) if pd.notna(bs_lo) else emp_lo
        hi = max(emp_hi, bs_hi) if pd.notna(bs_hi) else emp_hi
        return lo, hi

    los, his = zip(*[calibrate(r) for _, r in imp.iterrows()])
    imp["annual_m3_lower90"] = los
    imp["annual_m3_upper90"] = his

    # LPCD widens proportionally to flag tier (relative error applies to absolute units too)
    def calibrate_lpcd(row):
        if row["flag"] == "observed":
            return row["lpcd_lower90"], row["lpcd_upper90"]
        if pd.isna(row["lpcd_mean"]):
            return np.nan, np.nan
        q05, q95 = tiers.get(row["flag"], (-0.5, 0.5))
        m = row["lpcd_mean"]
        return m * (1 + q05), m * (1 + q95)

    los, his = zip(*[calibrate_lpcd(r) for _, r in imp.iterrows()])
    imp["lpcd_lower90"] = los
    imp["lpcd_upper90"] = his

    imp["mean_monthly_m3"] = imp["annual_m3_mean"] / 12.0
    imp["monthly_m3_lower90"] = imp["annual_m3_lower90"] / 12.0
    imp["monthly_m3_upper90"] = imp["annual_m3_upper90"] / 12.0

    final_cols = [
        "municipality", "urban_file", "year", "population",
        "lpcd_mean", "lpcd_lower90", "lpcd_upper90",
        "annual_m3_mean", "annual_m3_lower90", "annual_m3_upper90",
        "mean_monthly_m3", "monthly_m3_lower90", "monthly_m3_upper90",
        "flag", "n_overlap_years", "cv_ratio",
    ]
    imp[final_cols].to_csv(OUT / "urban_annual_imputed.csv", index=False)
    print(f"Wrote (calibrated per-tier) {OUT / 'urban_annual_imputed.csv'}")

    # In-sample coverage check per tier (sanity check that the calibration worked)
    print("\n=== Post-calibration in-sample coverage (per tier) ===")
    for tier in ["backcast_high", "backcast_mid", "backcast_low"]:
        rows = val[val.flag == tier].copy()
        if len(rows) == 0:
            continue
        q05, q95 = tiers[tier]
        rows["lo"] = rows["pred_annual_m3"] * (1 + q05)
        rows["hi"] = rows["pred_annual_m3"] * (1 + q95)
        covered = ((rows["true_annual_m3"] >= rows["lo"]) & (rows["true_annual_m3"] <= rows["hi"])).mean() * 100
        print(f"  {tier:15s}: n={len(rows):3d}  coverage = {covered:.1f}%  (target 90%)")

    # Write monthly broadcast
    rows = []
    out = imp[final_cols]
    for _, r in out.iterrows():
        for m in range(1, 13):
            rows.append({
                "year": int(r.year), "month": m,
                "municipality": r.municipality, "urban_file": r.urban_file,
                "demand_m3_mean": r.mean_monthly_m3,
                "demand_m3_lower90": r.monthly_m3_lower90,
                "demand_m3_upper90": r.monthly_m3_upper90,
                "flag": r.flag,
            })
    monthly = pd.DataFrame(rows)
    monthly.to_csv(OUT / "urban_monthly_broadcast.csv", index=False)
    print(f"\nWrote {OUT / 'urban_monthly_broadcast.csv'}  ({len(monthly):,} rows)")


if __name__ == "__main__":
    main()
