# Auxiliary datasets for Bulacan gap-filling

Reference data used as covariates / anchors for backcasting the urban water
demand gaps in `datasets_raw_bulacan/urban/`.

## Files

### `bulacan_population_census.csv`
Population per municipality for census years 1990, 2000, 2010, 2015, 2020, 2024.
Covers all 22 LGUs that appear in the urban CSVs, mapped to which file they
belong to via the `urban_file` column.

Source: citypopulation.de aggregation of PSA Census of Population and Housing.
Original authority: Philippine Statistics Authority (PSA).

Used for: per-capita water-demand backcasting. Inter-census years filled by
linear interpolation when the imputation runs.

### `bulacan_water_districts.csv`
LWUA water district establishment years where confirmed via web search.
Used to determine whether a district was operational before its first
data point in the source files - prevents backcasting demand for
non-existent infrastructure.

Confirmed pre-2000 districts: Norzagaray (1986), Bulacan (1989),
Bocaue (1979), Obando (1978). DRT inferred from Urban_1 record starting 2000.

Remaining districts need verification from LWUA directory or FOI.

## Provenance

Pulled 2026-05-12 via WebFetch/WebSearch:
- citypopulation.de Bulacan province page
- LWUA water district pages (norwd.gov.ph, bulacanwd.gov.ph, bocauewater.com)
- FOI Philippines (foi.gov.ph) cross-references
