# Agriculture — Land-Area-Proportional Disaggregation

How the per-municipality crop area estimates in this folder were derived, and the
general method Fluxo applies for any Philippine city, municipality, province, or region.

## Core idea

PSA publishes crop statistics (area harvested / area planted) only at the **province
level** for 2000–2015. To estimate each municipality's share we distribute the province
total in proportion to each municipality's **certified land area**:

```
share_i  =  municipality_land_area_ha  ÷  province_total_land_area_ha
value_i  =  province_crop_total        ×  share_i
```

Equivalently `value_i = province_total × (municipality_ha ÷ province_ha)`. The same
formula generalises to any parent area (region, province) split across any child areas
(provinces, cities, municipalities).

## Parameters used for Bulacan

- **Denominator (province total):** `278,369 ha` — PhilAtlas / PSA, citing the
  Land Management Bureau (LMB-DENR) Masterlist of Land Areas (the figure certified to
  the DBM for IRA computation). This denominator is fixed across every crop and year.
- **Municipality land areas:** PhilAtlas / PSA / LMB. The 22 study municipalities are
  grouped into 5 "Agri" files; see the source docx for per-municipality shares.
- **Province crop totals (numerator inputs):** PSA files — Rice 2000–2015
  (`2E4EAHC0.xlsx`, annual = Sem1 + Sem2 for 2000–2009), eight vegetables 2010–2015
  (`Bulacan__8_.csv`), and watermelon 2010–2015 (`2E4EAHM2.xlsx`).

Worked check: Rice 2000, DRT (93,296 ha) →
`72,960 × (93,296 ÷ 278,369) = 24,452.709 ha`, matching
`Annual (2000 to 2015)/Agri_1_Annual_2000_2015.csv`.

## Data scope and gaps

- **2000–2015 (annual files):** computed by the formula above. Vegetables/watermelon are
  blank before 2010 (no PSA data exists); rice 2000–2009 is summed from the semester file.
- **2016–2024 (monthly files):** actual field-survey values from the original Agri CSV
  uploads — **not** computed estimates.
- **2025–2050:** left blank in the raw files (no future data). Forward projection is done
  on demand by the Fluxo web app, not baked into these CSVs.

## Precision

Computed with Python's `Decimal` at 50-digit precision, `ROUND_HALF_UP` to 4 dp, then
trailing zeros stripped before writing to CSV. A full audit re-derived every stored value:
0 errors across all five annual files.

## In the Fluxo web app

The same disaggregation is available interactively: choose **Agriculture →
"Disaggregate from a parent-area total"**, upload the parent crop totals plus a two-column
land-area table (`Area, hectares`), and enter the parent total ha. The app computes each
share, splits the totals, then gap-fills and projects the result. See Methodology §2.5 in
`webapp/index.html`.
