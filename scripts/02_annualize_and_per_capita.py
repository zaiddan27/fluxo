"""
Stage 2: Collapse monthly-broadcast values into annual figures, merge with
population (interpolated between census years), compute per-capita demand (LPCD).

Output:
    datasets_processed_bulacan/intermediate/urban_annual_observed.csv
    columns: municipality, urban_file, year, mean_monthly_m3, annual_m3,
             population, lpcd, observed (bool)
"""

from pathlib import Path
import pandas as pd
import numpy as np

ROOT = Path(r"C:\Users\Lenovo\OneDrive\Pictures\Documents\Fluxo_Elijah")
INT = ROOT / "datasets_processed_bulacan" / "intermediate"
AUX = ROOT / "datasets_auxiliary_bulacan"


def annualize_urban(df_long):
    """For each (muni, year), take mean of the 12 broadcast monthly values.
    The mean preserves the annual-monthly-average meaning even if there are
    mid-year step changes (rare)."""
    agg = (
        df_long.groupby(["municipality", "urban_file", "year"])
        .agg(
            mean_monthly_m3=("demand_m3", "mean"),
            n_months_observed=("observed", "sum"),
        )
        .reset_index()
    )
    agg["observed"] = agg["mean_monthly_m3"].notna()
    agg["annual_m3"] = agg["mean_monthly_m3"] * 12
    return agg


def interpolate_population(pop_wide_df):
    """Linear interpolation of population between census years (1990, 2000, 2010,
    2015, 2020, 2024) for every year 2000..2024.

    Pre-1990 / post-2024 not needed for this dataset.
    Linear is the standard demographic-interpolation choice between census points.
    """
    census_years = [1990, 2000, 2010, 2015, 2020, 2024]
    all_years = list(range(2000, 2025))

    records = []
    for _, row in pop_wide_df.iterrows():
        muni = row["municipality"]
        urban_file = row["urban_file"]
        anchor_pop = {y: float(row[f"year_{y}"]) for y in census_years}
        ys = sorted(anchor_pop.keys())
        ps = [anchor_pop[y] for y in ys]
        for y in all_years:
            pop_interp = np.interp(y, ys, ps)
            records.append((muni, urban_file, y, pop_interp))
    return pd.DataFrame(records, columns=["municipality", "urban_file", "year", "population"])


def main():
    long = pd.read_csv(INT / "urban_long_raw.csv")
    annual = annualize_urban(long)

    pop_wide = pd.read_csv(AUX / "bulacan_population_census.csv")
    pop_long = interpolate_population(pop_wide)

    df = annual.merge(pop_long, on=["municipality", "urban_file", "year"], how="left")

    # LPCD = (annual m3 * 1000 L) / (population * 365 days)
    df["lpcd"] = np.where(
        df["observed"] & df["population"].notna(),
        df["annual_m3"] * 1000.0 / (df["population"] * 365.0),
        np.nan,
    )

    out = INT / "urban_annual_observed.csv"
    df = df[
        [
            "municipality", "urban_file", "year",
            "mean_monthly_m3", "annual_m3", "population", "lpcd",
            "observed", "n_months_observed",
        ]
    ].sort_values(["urban_file", "municipality", "year"]).reset_index(drop=True)
    df.to_csv(out, index=False)

    print(f"Wrote {out}")
    print(f"Rows: {len(df):,}  observed: {df['observed'].sum():,}  missing: {(~df['observed']).sum():,}")
    print()
    print("=== Observed LPCD by muni-year (anchors for trajectory model) ===")
    obs = df[df["observed"]].copy()
    print(obs.groupby("municipality").agg(
        n_years=("year", "count"),
        first_year=("year", "min"),
        min_lpcd=("lpcd", "min"),
        max_lpcd=("lpcd", "max"),
        last_lpcd=("lpcd", "last"),
    ).round(1).to_string())

    print()
    print("=== DRT LPCD trajectory (the anchor series) ===")
    drt = obs[obs.municipality == "Dona Remedios Trinidad"][["year", "annual_m3", "population", "lpcd"]]
    drt = drt.copy()
    drt["lpcd"] = drt["lpcd"].round(1)
    drt["population"] = drt["population"].round(0).astype(int)
    drt["annual_m3"] = drt["annual_m3"].round(0).astype(int)
    print(drt.to_string(index=False))


if __name__ == "__main__":
    main()
