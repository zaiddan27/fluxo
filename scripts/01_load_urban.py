"""
Stage 1: Load all 5 urban water-demand files into one long-format DataFrame.

Handles per-file quirks:
- BOM character on first line (\\ufeff)
- Metadata rows above the header
- Leading semicolon in header row
- xlsx file (Urban_5)
- Varying column names / leading spaces

Output:
    datasets_processed_bulacan/intermediate/urban_long_raw.csv
    columns: year, month, municipality, urban_file, demand_m3, observed
"""

from pathlib import Path
import pandas as pd
import numpy as np
import openpyxl

ROOT = Path(r"C:\Users\Lenovo\OneDrive\Pictures\Documents\Fluxo_Elijah")
RAW = ROOT / "datasets_raw_bulacan" / "urban"
OUT_DIR = ROOT / "datasets_processed_bulacan" / "intermediate"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def _clean_colname(name):
    if name is None:
        return None
    s = str(name).replace("﻿", "").lstrip(";").strip()
    return s


def load_csv_urban(path, urban_file_label):
    """All urban CSVs share the same structure: 2 metadata rows, row 3 is header."""
    df = pd.read_csv(path, header=2, encoding="utf-8-sig")
    df.columns = [_clean_colname(c) for c in df.columns]
    # First two columns should be Year, Month
    df = df.rename(columns={df.columns[0]: "year", df.columns[1]: "month"})
    df = df.dropna(subset=["year", "month"])
    df["year"] = df["year"].astype(int)
    df["month"] = df["month"].astype(int)
    # Melt municipalities into rows
    muni_cols = [c for c in df.columns if c not in ("year", "month")]
    long = df.melt(
        id_vars=["year", "month"],
        value_vars=muni_cols,
        var_name="municipality",
        value_name="demand_m3",
    )
    long["urban_file"] = urban_file_label
    return long


def load_xlsx_urban(path, urban_file_label):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    # Row 3 (index 2) has header
    header = [_clean_colname(c) for c in rows[2]]
    data_rows = rows[3:]
    df = pd.DataFrame(data_rows, columns=header)
    df = df.rename(columns={df.columns[0]: "year", df.columns[1]: "month"})
    df = df.dropna(subset=["year", "month"])
    df["year"] = df["year"].astype(int)
    df["month"] = df["month"].astype(int)
    muni_cols = [c for c in df.columns if c not in ("year", "month")]
    long = df.melt(
        id_vars=["year", "month"],
        value_vars=muni_cols,
        var_name="municipality",
        value_name="demand_m3",
    )
    long["urban_file"] = urban_file_label
    return long


def normalize_muni_name(name):
    """Strip leading whitespace and standardize spellings to match population file."""
    s = str(name).strip()
    mapping = {
        "DRT": "Dona Remedios Trinidad",
        "Bulacan": "Bulacan",
        "Meycauayan City": "Meycauayan City",
        "City of Malolos": "City of Malolos",
        "San Jose del Monte City": "San Jose del Monte City",
        "Baliwag": "Baliwag",
    }
    return mapping.get(s, s)


def main():
    parts = []
    parts.append(load_csv_urban(RAW / "Urban_1_DRT.csv", "Urban_1"))
    parts.append(load_csv_urban(RAW / "Urban_2(1).csv", "Urban_2"))
    parts.append(load_csv_urban(RAW / "Urban_3(1).csv", "Urban_3"))
    parts.append(load_csv_urban(RAW / "Urban_4_SM(1).csv", "Urban_4"))
    parts.append(load_xlsx_urban(RAW / "Urban_5_SanMiguel.xlsx", "Urban_5"))
    df = pd.concat(parts, ignore_index=True)
    df["municipality"] = df["municipality"].map(normalize_muni_name)
    df["demand_m3"] = pd.to_numeric(df["demand_m3"], errors="coerce")
    df["observed"] = df["demand_m3"].notna()
    df = df[["year", "month", "municipality", "urban_file", "demand_m3", "observed"]]
    df = df.sort_values(["urban_file", "municipality", "year", "month"]).reset_index(drop=True)

    out_path = OUT_DIR / "urban_long_raw.csv"
    df.to_csv(out_path, index=False)

    print(f"Wrote {out_path}")
    print(f"Total rows: {len(df):,}")
    print(f"Municipalities: {df['municipality'].nunique()}")
    print(f"Year range: {df['year'].min()} to {df['year'].max()}")
    print(f"\nObserved cells by muni (first observed year):")
    obs_summary = (
        df[df["observed"]]
        .groupby(["urban_file", "municipality"])
        .agg(first_year=("year", "min"),
             last_year=("year", "max"),
             n_obs_months=("observed", "sum"))
        .reset_index()
    )
    print(obs_summary.to_string(index=False))
    print(f"\nTotal NaN cells to consider for imputation: {(~df['observed']).sum():,}")


if __name__ == "__main__":
    main()
