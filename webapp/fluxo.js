/*========================================================================
 * FLUXO — CCCEM-CLSU
 * Nationwide Philippine Water Demand & Crop Planted/Harvested
 * Gap-Filling and Projection Platform.
 *
 * Pipeline:
 *   parse → annualise → gap-fill (MOVE / Hirsch 1982) → project (OLS) →
 *   classify confidence → render → interpret → export
 *
 * Computation depends strictly on the data the user uploads. No
 * external population, yield, or reference constants are baked in.
 *======================================================================*/

//=========================================================================
// STATE
//=========================================================================
const STATE = {
  category: null,      // "agriculture" | "water" | "riverflow"
  timeframe: null,     // "current" | "projected" | "both"
  granularity: null,   // "annual" | "monthly"
  popMode: null,       // "with" | "without"  (agri: "with" = disaggregate)
  fileMain: null,
  filePop:  null,
  parentTotalHa: null, // agri disaggregation: parent (province/region) total land area in ha
  datasetLabel: "",    // group/municipality label captured from the uploaded file (annual export row 1)
  results:  null,
  rangeStart: 2000,
  rangeEnd:   2024     // updated per timeframe choice
};

// Output horizons per timeframe choice.
//   current   → 2000–2024 (historical gap-fill only)
//   projected → 2025–2050 (future projection only)
//   both      → 2000–2050 (gap-fill + projection)
// Trend / station-substitution always fit from the observed years present in
// the data, independent of the output window, so a future-only window still
// fits its trend from the observed record.
const HORIZON_CURRENT   = { start: 2000, end: 2024 };
const HORIZON_PROJECTED = { start: 2025, end: 2050 };
const HORIZON_BOTH      = { start: 2000, end: 2050 };
function horizonFor(timeframe) {
  if (timeframe === "projected") return HORIZON_PROJECTED;
  if (timeframe === "both")      return HORIZON_BOTH;
  return HORIZON_CURRENT;
}

// Confidence-tier classification thresholds.
function classifyTier(nOverlap, cvR) {
  if (nOverlap >= 5 && cvR <= 0.20) return "backcast_high";
  if (nOverlap >= 3 && cvR <= 0.35) return "backcast_mid";
  return "backcast_low";
}

// Per-tier empirical (true-pred)/pred quantiles. These are the calibrated
// 90% prediction bounds from the validation study described in the
// methodology section.
const TIERS = {
  backcast_high: { q05: -0.21, q95: 0.34 },
  backcast_mid:  { q05: -0.13, q95: 1.21 },
  backcast_low:  { q05:  0.15, q95: 2.15 }
};

// River-flow projection uses the Climate Delta Scaling Method (PAGASA 2018,
// Region III / Central Luzon), exactly as documented for the Angat/Sta-Maria
// Bulacan projections:  Q(y,m) = max{ Q_base(m) × [1 + δ(m)·φ(y)] , floor }.
// δ(m) is the fractional rainfall (≈ streamflow) change projected for 2050 vs
// the 2010 baseline, by season and emission scenario:
//   DJF = months 12,1,2 · MAM = 3,4,5 · JJA = 6,7,8 · SON = 9,10,11.
const CLIMATE_SEASON = { 12:"DJF",1:"DJF",2:"DJF", 3:"MAM",4:"MAM",5:"MAM",
                         6:"JJA",7:"JJA",8:"JJA", 9:"SON",10:"SON",11:"SON" };
const CLIMATE_DELTAS = {
  BASE: { DJF:-0.08, MAM:-0.05, JJA:0.05, SON:0.04 },  // RCP4.5 — most likely
  HIGH: { DJF:-0.15, MAM:-0.12, JJA:0.10, SON:0.08 },  // RCP8.5 — upper bound
  LOW:  { DJF:-0.03, MAM:-0.02, JJA:0.02, SON:0.01 }   // RCP2.6 — lower bound
};
const CLIMATE_BASELINE_YEAR = 2010;   // φ = 0 here (IPCC reference)
const CLIMATE_TARGET_YEAR   = 2050;   // φ = 1 here (full delta applied)
const RIVER_MIN_FLOW        = 0.001;  // physical floor (cms) — never reached in practice
// Planning envelope around a single projected value (doc §8.2: CV>60% ⇒ ±40%).
const RIVER_ENVELOPE        = 0.40;

function climateDelta(scenario, month) {
  return CLIMATE_DELTAS[scenario][CLIMATE_SEASON[month]];
}
function climatePhi(year) {
  const f = (year - CLIMATE_BASELINE_YEAR) / (CLIMATE_TARGET_YEAR - CLIMATE_BASELINE_YEAR);
  return Math.min(1, Math.max(0, f));
}

// Q_base(m): the climatological baseline — median (robust to skew/outliers per
// WMO 2017) of the observed monthly cms for each calendar month across all years.
function computeMonthlyMedian(annualBy) {
  const byMonth = Array.from({ length: 12 }, () => []);
  for (const y of Object.keys(annualBy)) {
    const row = annualBy[+y];
    if (!row || !row.monthly_cms) continue;
    for (let m = 1; m <= 12; m++) {
      if (row.monthly_cms[m] != null) byMonth[m - 1].push(row.monthly_cms[m]);
    }
  }
  return byMonth.map(arr => (arr.length ? median(arr) : null));
}

// Mann-Kendall trend test (Hirsch-Slack-Smith 1982) on annual values — the
// doc's decision point. Returned for reporting; the projection itself uses the
// climate-delta method regardless (extrapolating an insignificant noise slope,
// or an unbounded significant one, is what produced negative flows before).
function mannKendall(values) {
  const n = values.length;
  if (n < 4) return null;
  let S = 0;
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) S += Math.sign(values[j] - values[i]);
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;
  let Z = 0;
  if (S > 0) Z = (S - 1) / Math.sqrt(varS);
  else if (S < 0) Z = (S + 1) / Math.sqrt(varS);
  return { S, Z, significant: Math.abs(Z) > 1.96 };
}

//=========================================================================
// SMALL UTILITIES
//=========================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Build an annotated error that the run handler renders gracefully:
// a plain-language message, an optional "what to do" hint, and an optional
// example of the expected file layout.
function userError(message, hint, example) {
  const e = new Error(message);
  e.userFacing = true;
  e.hint = hint || null;
  e.example = example || null;
  return e;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
}
function fmtInt(x) { if (x == null || isNaN(x)) return "—"; return Math.round(x).toLocaleString(); }
function fmt1(x)   { if (x == null || isNaN(x)) return "—"; return x.toFixed(1); }
function fmt2(x)   { if (x == null || isNaN(x)) return "—"; return x.toFixed(2); }

// OLS regression on (year, value) pairs.
function ols(years, values) {
  const n = years.length;
  if (n < 2) return null;
  const ymean = mean(years);
  const vmean = mean(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (years[i] - ymean) * (values[i] - vmean);
    den += (years[i] - ymean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = vmean - slope * ymean;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * years[i];
    ssRes += (values[i] - pred) ** 2;
    ssTot += (values[i] - vmean) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const seResid = Math.sqrt(ssRes / Math.max(1, n - 2));
  return { slope, intercept, r2, seResid, n };
}

//=========================================================================
// FILE PARSING
//=========================================================================
async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return parseXlsx(file);
  }
  return parseCsv(file);
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      complete: (res) => resolve(rowsToMatrix(res.data)),
      error: reject,
      skipEmptyLines: false
    });
  });
}

function parseXlsx(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        resolve(rows);
      } catch (err) { reject(err); }
    };
    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}

function rowsToMatrix(rows) {
  return rows.map(r => Array.isArray(r) ? r : Object.values(r));
}

//=========================================================================
// HEADER DETECTION & COLUMN EXTRACTION
//=========================================================================
function cleanLocationName(raw) {
  if (raw == null) return null;
  return String(raw).replace(/^[\s;,]+|[\s;,]+$/g, "").trim();
}

// Capture the group/municipality label that sits above the Year header row
// (e.g. "DRT" in the source annual files). Used as the row-1 label on the
// annual export. Returns "" when the header is the first row or none found.
function findGroupLabel(rows) {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i];
    if (r && r.some(c => c != null && String(c).toLowerCase().replace(/[;\s]/g, "").includes("year"))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx <= 0) return "";
  for (let i = 0; i < headerIdx; i++) {
    const r = rows[i];
    if (!r) continue;
    for (const c of r) {
      const v = c == null ? "" : String(c).replace(/^[;\s]+|[\s]+$/g, "").trim();
      if (v && !/year|month/i.test(v)) return v;
    }
  }
  return "";
}

function extractSeries(rows) {
  // Find the header row.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i];
    if (!r) continue;
    for (const cell of r) {
      if (cell != null && String(cell).toLowerCase().replace(/[;\s]/g, "").includes("year")) {
        headerIdx = i; break;
      }
    }
    if (headerIdx >= 0) break;
  }
  const WIDE_EXAMPLE =
`Year, Month, Location A, Location B
2010, 1, 12.5, 8.3
2010, 2, 13.1, 8.0`;
  if (headerIdx < 0) throw userError(
    "We couldn't find a “Year” column in this file.",
    "Fluxo reads wide-format tables. The header row needs a column named <strong>Year</strong> (a <strong>Month</strong> column is optional), followed by one column per location. A leading <code>;</code> on the first header cell is fine. Check that you uploaded the data file — not a chart, summary, or land-area table — and that the header isn’t buried below row 10.",
    WIDE_EXAMPLE);

  const header = rows[headerIdx].map(c => c == null ? "" : String(c).replace(/^[;\s]+|[\s]+$/g, "").trim());
  const yearCol = header.findIndex(c => c.toLowerCase().includes("year"));
  const monthCol = header.findIndex(c => c.toLowerCase().includes("month"));
  if (yearCol < 0) throw userError(
    "We found a header row, but no “Year” column in it.",
    "Rename one of your columns to <strong>Year</strong> (four-digit years between 1900 and 2100).",
    WIDE_EXAMPLE);

  // All remaining non-empty header columns are location series.
  const locCols = [];
  for (let i = 0; i < header.length; i++) {
    if (i === yearCol || i === monthCol) continue;
    if (!header[i] || header[i].trim() === "") continue;
    locCols.push({ name: cleanLocationName(header[i]), colIdx: i });
  }
  if (locCols.length === 0) throw userError(
    "Your file has a Year column but no data columns next to it.",
    "Add at least one value column to the right of Year/Month — one per location (e.g. a crop, water district, or gauging station). Each becomes its own result series.",
    WIDE_EXAMPLE);

  // Walk data rows.
  const byLoc = {};
  for (const lc of locCols) byLoc[lc.name] = { name: lc.name, records: [] };
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const y = parseFloat(r[yearCol]);
    if (isNaN(y) || y < 1900 || y > 2100) continue;
    const m = monthCol >= 0 ? parseFloat(r[monthCol]) : 1;
    const month = (monthCol >= 0 && !isNaN(m)) ? Math.round(m) : 1;
    for (const lc of locCols) {
      const v = r[lc.colIdx];
      const num = (v === "" || v == null) ? null : parseFloat(v);
      byLoc[lc.name].records.push({
        year: Math.round(y),
        month,
        value: (num == null || isNaN(num)) ? null : num
      });
    }
  }
  return Object.values(byLoc);
}

//=========================================================================
// ANNUALISE
//=========================================================================
function annualize(records) {
  const byYear = {};
  for (const rec of records) {
    if (!byYear[rec.year]) byYear[rec.year] = [];
    if (rec.value != null) byYear[rec.year].push(rec.value);
  }
  const annual = {};
  for (const y of Object.keys(byYear)) {
    const vals = byYear[y];
    if (vals.length > 0) {
      const m = mean(vals);
      // Detect input shape: ≥ 6 rows for the year ⇒ monthly-broadcast input
      // (multiply by 12 for the annual figure). Otherwise treat the mean as
      // the annual figure already. monthly_mean always equals the per-row mean
      // (a 12-row series with identical V gives monthly_mean = V).
      const monthlyShape = vals.length >= 6;
      annual[+y] = {
        monthly_mean: monthlyShape ? m : m / 12,
        annual: monthlyShape ? m * 12 : m
      };
    } else {
      annual[+y] = { monthly_mean: null, annual: null };
    }
  }
  return annual;
}

//-------------------------------------------------------------------------
// River-flow annualiser — stays in cms (m³/s). The per-year "level" is the
// mean of the observed monthly cms readings; per-month cms is preserved so
// real seasonality survives. We only ever predict the missing cms values.
//-------------------------------------------------------------------------
function annualizeRiverFlow(records) {
  const byYear = {};
  for (const rec of records) {
    if (rec.value == null) continue;
    if (!byYear[rec.year]) byYear[rec.year] = { months: {}, sum: 0, count: 0 };
    byYear[rec.year].months[rec.month] = rec.value;
    byYear[rec.year].sum += rec.value;
    byYear[rec.year].count += 1;
  }
  const annual = {};
  for (const y of Object.keys(byYear)) {
    const obj = byYear[+y];
    if (obj.count === 0) {
      annual[+y] = { monthly_mean: null, annual: null, monthly_cms: null };
      continue;
    }
    // Year level = mean cms over the observed months (incomplete years simply
    // average the months that exist). This is the value gap-filled/projected.
    const meanCms = obj.sum / obj.count;
    annual[+y] = {
      monthly_mean: meanCms,
      annual: meanCms,
      monthly_cms: obj.months
    };
  }
  return annual;
}

//-------------------------------------------------------------------------
// Seasonal-multiplier estimation from observed years (mean = 1).
// monthMultiplier[m] × year-mean-cms reconstructs a month's cms, so it is
// used to predict missing months and to redistribute predicted year levels
// across the twelve months when the category is river flow.
//-------------------------------------------------------------------------
function computeSeasonalShape(annualBy) {
  const sums = Array(12).fill(0);
  const counts = Array(12).fill(0);
  for (const y of Object.keys(annualBy)) {
    const row = annualBy[+y];
    if (!row || !row.monthly_cms || !row.annual) continue;
    for (let m = 1; m <= 12; m++) {
      if (row.monthly_cms[m] != null) {
        sums[m - 1] += row.monthly_cms[m] / row.annual; // ratio to year mean
        counts[m - 1] += 1;
      }
    }
  }
  const raw = sums.map((s, i) => counts[i] > 0 ? s / counts[i] : 1);
  const avg = raw.reduce((a, b) => a + b, 0) / 12 || 1;
  return raw.map(v => v / avg); // normalise → mean of 1
}

//=========================================================================
// POPULATION HANDLING — strictly user-provided
//=========================================================================
function popLookup(popSeriesByName, locName, year) {
  if (!popSeriesByName) return null;
  const series = popSeriesByName[locName];
  if (!series) return null;
  // Population is a stock (not a flow), so we use monthly_mean — i.e. the
  // per-row value the user uploaded — directly, regardless of whether they
  // supplied 1 row/year or 12 rows/year.
  const valueAt = (y) => (series[y] && series[y].monthly_mean != null) ? series[y].monthly_mean : null;
  if (valueAt(year) != null) return valueAt(year);
  const ys = Object.keys(series).map(Number).filter(y => valueAt(y) != null).sort((a, b) => a - b);
  if (!ys.length) return null;
  if (year <= ys[0]) return valueAt(ys[0]);
  if (year >= ys[ys.length - 1]) return valueAt(ys[ys.length - 1]);
  for (let i = 0; i < ys.length - 1; i++) {
    if (year >= ys[i] && year <= ys[i + 1]) {
      const y0 = ys[i], y1 = ys[i + 1];
      const p0 = valueAt(y0), p1 = valueAt(y1);
      return p0 + (p1 - p0) * (year - y0) / (y1 - y0);
    }
  }
  return null;
}

//=========================================================================
// TEMPLATE SELECTION — pick the longest observed series as anchor.
//=========================================================================
function selectTemplate(seriesArr) {
  // Score each series by # observed years; tiebreak by earliest first-observed year.
  let best = null, bestScore = -1;
  for (const s of seriesArr) {
    const ys = Object.keys(s.annual).map(Number).filter(y => s.annual[y].annual != null);
    if (!ys.length) continue;
    const earliest = Math.min(...ys);
    const score = ys.length * 100 - earliest;  // earlier start breaks ties
    if (score > bestScore) {
      bestScore = score;
      best = { name: s.name, observedYears: ys.sort((a, b) => a - b) };
    }
  }
  return best;
}

//=========================================================================
// GAP-FILL (CURRENT) + PROJECTION
//=========================================================================
function processSeries(s, template, templateAnnual, popSeries, opts) {
  const { popMode, timeframe, category } = opts;
  const start = STATE.rangeStart;
  const end = STATE.rangeEnd;

  // Observed years for this series.
  const ys = Object.keys(s.annual).map(Number).filter(y => s.annual[y].annual != null).sort((a, b) => a - b);
  if (!ys.length) {
    return { supported: false, name: s.name, reason: "This column has no numeric values, so there's nothing to gap-fill or project. Add at least one observed value, or remove the empty column." };
  }
  const firstObs = ys[0];
  const lastObs  = ys[ys.length - 1];

  // Build a working value series in the chosen normalised space. LPCD
  // normalisation applies only to Urban Water Use; for agriculture the "with"
  // option means land-area disaggregation (done upstream), not per-capita.
  const useLPCD = category === "water" && popMode === "with";
  function toNorm(annualVal, year) {
    if (!useLPCD) return annualVal;
    const pop = popLookup(popSeries, s.name, year);
    if (pop == null || pop <= 0) return null;
    return (annualVal * 1000) / (pop * 365); // LPCD
  }
  function fromNorm(normVal, year) {
    if (!useLPCD) return normVal;
    const pop = popLookup(popSeries, s.name, year);
    if (pop == null || pop <= 0) return null;
    return (normVal * pop * 365) / 1000;
  }

  // Compute observed-normalised series.
  const obsNorm = {};
  for (const y of ys) {
    const v = toNorm(s.annual[y].annual, y);
    if (v != null) obsNorm[y] = v;
  }
  const obsNormYears = Object.keys(obsNorm).map(Number).sort((a, b) => a - b);

  // Template normalised series.
  const tplNorm = {};
  if (template) {
    for (const y of Object.keys(templateAnnual).map(Number)) {
      const av = templateAnnual[y].annual;
      if (av == null) continue;
      let v;
      if (useLPCD && s.name !== template.name) {
        // Template normalisation must use its OWN population for LPCD.
        const tplPop = popLookup(popSeries, template.name, y);
        v = (tplPop && tplPop > 0) ? (av * 1000) / (tplPop * 365) : null;
      } else {
        v = av;
      }
      if (v != null) tplNorm[y] = v;
    }
  }

  // Backcast ratios against template (only when this series ≠ template).
  let ratios = [], Rmed = null, Rcv = null, tier = null;
  if (template && s.name !== template.name) {
    const overlap = obsNormYears.filter(y => tplNorm[y] != null);
    ratios = overlap.map(y => obsNorm[y] / tplNorm[y]).filter(r => isFinite(r) && r > 0);
    if (ratios.length > 0) {
      Rmed = median(ratios);
      const Rmean = mean(ratios);
      Rcv = Rmean > 0 ? stdev(ratios) / Rmean : Infinity;
      tier = classifyTier(ratios.length, Rcv);
    }
  }

  // OLS trend on observed-norm values (for projection AND low-data backcast fallback).
  const trend = obsNormYears.length >= 2
    ? ols(obsNormYears, obsNormYears.map(y => obsNorm[y]))
    : null;

  // Build output rows for the full horizon.
  const rows = {};
  const Z90 = 1.645;

  for (let y = start; y <= end; y++) {
    const observedAnnual = s.annual[y]?.annual ?? null;

    // 1) Observed pass-through.
    if (observedAnnual != null) {
      rows[y] = {
        year: y,
        value_mean: observedAnnual,
        value_lower90: observedAnnual,
        value_upper90: observedAnnual,
        monthly_mean: observedAnnual / 12,
        flag: "observed",
        population: popMode === "with" ? popLookup(popSeries, s.name, y) : null,
        norm_mean: obsNorm[y] ?? null
      };
      continue;
    }

    // 2) Backcast — pre-firstObs and we have a template ratio.
    if (y < firstObs && Rmed != null && tplNorm[y] != null) {
      const norm_mean = Rmed * tplNorm[y];
      const tierQ = TIERS[tier] || TIERS.backcast_low;
      const norm_lo = norm_mean * (1 + tierQ.q05);
      const norm_hi = norm_mean * (1 + tierQ.q95);
      const val_mean = fromNorm(norm_mean, y);
      const val_lo   = fromNorm(norm_lo, y);
      const val_hi   = fromNorm(norm_hi, y);
      if (val_mean != null) {
        rows[y] = {
          year: y,
          value_mean: val_mean,
          value_lower90: val_lo,
          value_upper90: val_hi,
          monthly_mean: val_mean / 12,
          flag: tier,
          population: popMode === "with" ? popLookup(popSeries, s.name, y) : null,
          norm_mean
        };
        continue;
      }
    }

    // 3-river) River flow forward projection — Climate Delta Scaling (PAGASA
    // 2018). Holds the observed monthly-median seasonal pattern and shifts it by
    // the projected seasonal rainfall change, ramped linearly 2010→2050. This is
    // the documented Bulacan river method; it is non-negative by construction
    // (physical floor) and replaces the unbounded OLS slope that drove flows
    // negative. The HIGH/LOW RCP scenarios set the planning band.
    if (y > lastObs && category === "riverflow" && s.baseMonthlyMedian) {
      const phi = climatePhi(y);
      const mcms = {};
      let sum = 0, cnt = 0;
      for (let m = 1; m <= 12; m++) {
        const qb = s.baseMonthlyMedian[m - 1];
        if (qb == null) continue;
        mcms[m] = Math.max(qb * (1 + climateDelta("BASE", m) * phi), RIVER_MIN_FLOW);
        sum += mcms[m];
        cnt++;
      }
      if (cnt > 0) {
        const val_mean = sum / cnt;
        rows[y] = {
          year: y,
          value_mean: val_mean,
          value_lower90: val_mean * (1 - RIVER_ENVELOPE),
          value_upper90: val_mean * (1 + RIVER_ENVELOPE),
          monthly_mean: val_mean / 12,
          monthly_cms: mcms,
          flag: "forecast",
          population: null,
          norm_mean: val_mean
        };
        continue;
      }
    }

    // 3) Projection — y > lastObs and we have a fitted trend.
    if (y > lastObs && trend) {
      const norm_mean = trend.intercept + trend.slope * y;
      const norm_lo = norm_mean - Z90 * trend.seResid;
      const norm_hi = norm_mean + Z90 * trend.seResid;
      // Areas, water volumes and river flow are non-negative physical quantities;
      // a declining OLS trend can push the extrapolation below zero, which is
      // unphysical. Floor every projected figure at 0 (matching the source data,
      // where forecast values bottom out at 0 rather than going negative).
      const nonNeg  = (v) => (v == null ? null : Math.max(0, v));
      const val_mean = nonNeg(fromNorm(norm_mean, y));
      const val_lo   = nonNeg(fromNorm(norm_lo, y));
      const val_hi   = nonNeg(fromNorm(norm_hi, y));
      if (val_mean != null) {
        rows[y] = {
          year: y,
          value_mean: val_mean,
          value_lower90: val_lo,
          value_upper90: val_hi,
          monthly_mean: val_mean / 12,
          flag: "forecast",
          population: popMode === "with" ? popLookup(popSeries, s.name, y) : null,
          norm_mean
        };
        continue;
      }
    }

    // 3b) Interior gap — linearly interpolate between bracketing observed years.
    if (y > firstObs && y < lastObs) {
      let yLow = null, yHigh = null;
      for (let k = y - 1; k >= firstObs; k--) {
        if (s.annual[k] && s.annual[k].annual != null) { yLow = k; break; }
      }
      for (let k = y + 1; k <= lastObs; k++) {
        if (s.annual[k] && s.annual[k].annual != null) { yHigh = k; break; }
      }
      if (yLow != null && yHigh != null && obsNorm[yLow] != null && obsNorm[yHigh] != null) {
        const norm_mean = obsNorm[yLow] + (obsNorm[yHigh] - obsNorm[yLow]) * (y - yLow) / (yHigh - yLow);
        const val_mean = fromNorm(norm_mean, y);
        if (val_mean != null) {
          rows[y] = {
            year: y,
            value_mean: val_mean,
            value_lower90: val_mean * 0.88,
            value_upper90: val_mean * 1.12,
            monthly_mean: val_mean / 12,
            flag: "backcast_mid",
            population: popMode === "with" ? popLookup(popSeries, s.name, y) : null,
            norm_mean
          };
          continue;
        }
      }
    }

    // 4) Agriculture fallback — emit a flagged best-estimate rather than refuse.
    if (category === "agriculture" && (y < firstObs || y > lastObs)) {
      // Use last observed (forward) or first observed (backward) as constant.
      const anchorY = y < firstObs ? firstObs : lastObs;
      const anchorNorm = obsNorm[anchorY];
      if (anchorNorm != null) {
        const val_mean = fromNorm(anchorNorm, y);
        if (val_mean != null) {
          rows[y] = {
            year: y,
            value_mean: val_mean,
            value_lower90: val_mean * 0.5,
            value_upper90: val_mean * 1.5,
            monthly_mean: val_mean / 12,
            flag: y > lastObs ? "forecast" : "backcast_low",
            population: popMode === "with" ? popLookup(popSeries, s.name, y) : null,
            norm_mean: anchorNorm
          };
          continue;
        }
      }
    }

    // 5) Truly missing.
    rows[y] = {
      year: y, value_mean: null, value_lower90: null, value_upper90: null,
      monthly_mean: null, flag: "missing",
      population: popMode === "with" ? popLookup(popSeries, s.name, y) : null,
      norm_mean: null
    };
  }

  // For river flow: preserve the actual per-month cms on observed years,
  // and attach the series-level seasonal multiplier so renderers / exporters
  // can predict cms for missing months and fully missing years.
  if (s.seasonalShape) {
    for (const y of Object.keys(rows).map(Number)) {
      const obs = s.annual[y];
      if (obs && obs.monthly_cms && rows[y].flag === "observed") {
        rows[y].monthly_cms = obs.monthly_cms;
      }
    }
  }

  return {
    supported: true,
    name: s.name,
    rows,
    overlap: ratios.length,
    cv: Rcv,
    Rmedian: Rmed,
    tier,
    template: template ? template.name : null,
    trend,
    seasonalShape: s.seasonalShape || null,
    baseMonthlyMedian: s.baseMonthlyMedian || null,
    mk: s.mk || null
  };
}

//=========================================================================
// LAND-AREA TABLE PARSER (agriculture disaggregation)
// Accepts a simple two-column CSV/XLSX: <Area name>, <Land area (ha)>.
// A header row (no numeric area) is skipped automatically.
//=========================================================================
function parseLandTable(rows) {
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const cells = (Array.isArray(r) ? r : Object.values(r))
      .map(c => (c == null ? "" : String(c).trim()));
    let ha = null, name = null;
    for (const c of cells) {
      if (c === "") continue;
      const n = parseFloat(c.replace(/,/g, ""));
      const isNum = /\d/.test(c) && !isNaN(n);
      if (ha == null && isNum) ha = n;
      else if (name == null && !isNum) {
        // Strip the leading-semicolon / stray-punctuation convention; only
        // accept a name once something real remains.
        const cleaned = cleanLocationName(c);
        if (cleaned) name = cleaned;
      }
    }
    if (ha != null && ha > 0 && name) out.push({ area: name, ha });
  }
  return out;
}

//=========================================================================
// AGRI DISAGGREGATION — split a parent-area crop total across child areas
// by land-area share:  child(c,y) = parent_total(c,y) × (area_ha ÷ parent_ha)
//=========================================================================
function disaggregateByLandArea(parentSeries, land, parentTotalHa) {
  const sumHa = land.reduce((a, b) => a + b.ha, 0);
  const denom = (parentTotalHa && parentTotalHa > 0) ? parentTotalHa : sumHa;
  const multiCrop = parentSeries.length > 1;
  const series = [];
  for (const area of land) {
    const share = denom > 0 ? area.ha / denom : 0;
    for (const crop of parentSeries) {
      const name = multiCrop ? `${area.area} · ${crop.name}` : area.area;
      const records = crop.records.map(rec => ({
        year: rec.year,
        month: rec.month,
        value: rec.value == null ? null : rec.value * share
      }));
      series.push({ name, records, share, area: area.area });
    }
  }
  return series;
}

//=========================================================================
// PIPELINE ENTRY
//=========================================================================
async function runPipeline() {
  // Horizon depends on timeframe choice.
  const horizon = horizonFor(STATE.timeframe);
  STATE.rangeStart = horizon.start;
  STATE.rangeEnd   = horizon.end;

  const isRiverFlow = STATE.category === "riverflow";
  const isAgriDisagg = STATE.category === "agriculture" && STATE.popMode === "with";

  // Parse main file.
  const mainRows = await parseFile(STATE.fileMain);
  STATE.datasetLabel = findGroupLabel(mainRows);
  let mainSeries;
  if (isAgriDisagg) {
    // Main file holds the parent-area crop totals (each value column = a crop);
    // the second file is a land-area table used to split them by share.
    const parentSeries = extractSeries(mainRows);
    if (!STATE.filePop) throw userError(
      "Disaggregation needs a land-area table in the second upload slot.",
      "Add a CSV/XLSX with two columns — area name and land area in hectares — then run again. Or go back to Step 4 and pick “I already have per-location values” to skip disaggregation.",
      "Area, Land area (ha)\nDoña Remedios Trinidad, 93296\nNorzagaray, 30977");
    const land = parseLandTable(await parseFile(STATE.filePop));
    if (!land.length) throw userError(
      "We couldn't read any areas from the land-area table.",
      "Use exactly two columns — the area name and its land area in hectares. A header row is fine and will be skipped; numbers may include commas (e.g. 93,296).",
      "Area, Land area (ha)\nDoña Remedios Trinidad, 93296\nNorzagaray, 30977");
    mainSeries = disaggregateByLandArea(parentSeries, land, STATE.parentTotalHa);
  } else {
    mainSeries = extractSeries(mainRows);
  }

  // River flow uses a cms annualiser and preserves a per-year seasonal shape.
  for (const s of mainSeries) {
    s.annual = isRiverFlow ? annualizeRiverFlow(s.records) : annualize(s.records);
    if (isRiverFlow) {
      s.seasonalShape = computeSeasonalShape(s.annual);
      s.baseMonthlyMedian = computeMonthlyMedian(s.annual);
      const obsAnnual = Object.keys(s.annual).map(Number).sort((a, b) => a - b)
        .map(y => s.annual[y].annual).filter(v => v != null);
      s.mk = mannKendall(obsAnnual);
    }
  }

  // Parse optional population file — water only (LPCD normalisation).
  let popSeriesByName = null;
  if (STATE.category === "water" && STATE.popMode === "with" && STATE.filePop) {
    const popRows = await parseFile(STATE.filePop);
    const popSeries = extractSeries(popRows);
    popSeriesByName = {};
    for (const ps of popSeries) {
      popSeriesByName[ps.name] = annualize(ps.records);
    }
  }

  // Choose template (longest record).
  const template = selectTemplate(mainSeries);
  const templateAnnual = template
    ? mainSeries.find(s => s.name === template.name).annual
    : null;

  // Process each series.
  const results = [];
  for (const s of mainSeries) {
    results.push(processSeries(s, template, templateAnnual, popSeriesByName, {
      popMode: STATE.popMode,
      timeframe: STATE.timeframe,
      category: STATE.category
    }));
  }
  return { results, template };
}

//=========================================================================
// INTERPRETATION — natural-language summary of one series
//=========================================================================
function interpretSeries(r, opts) {
  const { category, timeframe, popMode } = opts;
  if (!r.supported) return [`${r.name}: could not be processed — ${r.reason}`];

  const unit = category === "water" ? "m³ per year"
             : category === "riverflow" ? "cms (mean)"
             : "ha";
  const monthlyUnit = category === "riverflow" ? "cms per month"
             : category === "water" ? "m³ per month" : "ha (monthly slice)";
  // River-flow values are small; keep decimals in the prose too.
  const fmtU = category === "riverflow" ? fmt2 : fmtInt;

  const years = Object.keys(r.rows).map(Number).sort((a, b) => a - b);
  const observed = years.filter(y => r.rows[y].flag === "observed");
  const backcast = years.filter(y => r.rows[y].flag && r.rows[y].flag.startsWith("backcast"));
  const forecast = years.filter(y => r.rows[y].flag === "forecast");
  const missing  = years.filter(y => r.rows[y].flag === "missing");

  const obsValues = observed.map(y => r.rows[y].value_mean).filter(v => v != null && isFinite(v));
  const firstObsY = observed.length ? Math.min(...observed) : null;
  const lastObsY  = observed.length ? Math.max(...observed) : null;
  const firstObsV = firstObsY != null ? r.rows[firstObsY].value_mean : null;
  const lastObsV  = lastObsY  != null ? r.rows[lastObsY].value_mean  : null;

  const insights = [];

  // Coverage line.
  insights.push(`Coverage: <strong>${observed.length}</strong> observed years, ` +
                `<strong>${backcast.length}</strong> reconstructed, ` +
                `<strong>${forecast.length}</strong> projected, ` +
                `<strong>${missing.length}</strong> missing.`);

  // Trend / growth.
  if (firstObsV != null && lastObsV != null && firstObsY !== lastObsY && firstObsV > 0) {
    const yrs = lastObsY - firstObsY;
    const cagr = (Math.pow(lastObsV / firstObsV, 1 / yrs) - 1) * 100;
    insights.push(`Observed growth: <strong>${cagr >= 0 ? "+" : ""}${cagr.toFixed(2)}% CAGR</strong> ` +
                  `from ${firstObsY} (${fmtU(firstObsV)} ${unit}) to ${lastObsY} (${fmtU(lastObsV)} ${unit}).`);
  } else if (obsValues.length === 1) {
    insights.push(`Only one observed year (${firstObsY}). Trend metrics cannot be computed; backcasts rely on template substitution.`);
  }

  // Backcast quality.
  if (backcast.length > 0) {
    const tierLabel = r.tier ? r.tier.replace("backcast_", "") + "-confidence" : "modelled";
    if (r.Rmedian != null && r.overlap != null) {
      insights.push(`Backcasts are ${tierLabel}, computed against the <strong>${r.template}</strong> template ` +
                    `using <strong>${r.overlap}</strong> overlap years ` +
                    `(R̂ = ${r.Rmedian.toFixed(3)}, CV = ${(r.cv * 100).toFixed(1)}%).`);
    } else {
      insights.push(`Backcasts produced via fallback estimation; treat as indicative.`);
    }
  }

  // Forecast horizon.
  if (forecast.length > 0) {
    const lastFc = Math.max(...forecast);
    const v = r.rows[lastFc].value_mean;
    const lo = r.rows[lastFc].value_lower90;
    const hi = r.rows[lastFc].value_upper90;
    insights.push(`Projection to <strong>${lastFc}</strong>: ` +
                  `<strong>${fmtU(v)}</strong> ${unit} (90% CI: ${fmtU(lo)}–${fmtU(hi)}).`);

    if (category !== "riverflow" && r.trend && r.trend.slope != null && lastObsV != null && lastObsV > 0) {
      const pctChange = ((v - lastObsV) / lastObsV) * 100;
      const direction = pctChange >= 0 ? "growth" : "decline";
      insights.push(`Implied <strong>${direction}</strong> of <strong>${Math.abs(pctChange).toFixed(1)}%</strong> ` +
                    `over the projection horizon (R² of fit = ${r.trend.r2.toFixed(2)}).`);
    }
  }

  // Domain-specific framing.
  if (category === "water" && popMode === "with" && r.rows[lastObsY]) {
    const norm = r.rows[lastObsY].norm_mean;
    if (norm != null) {
      insights.push(`Observed per-capita demand in ${lastObsY}: <strong>${fmt1(norm)} LPCD</strong>.`);
    }
  }
  if (category === "agriculture") {
    insights.push(`Agriculture mode prioritises continuity of prediction; flagged backcasts/forecasts are best-estimates rather than archival values.`);
  }
  if (category === "riverflow") {
    insights.push(`River flow stays in <strong>cms (m³/s)</strong>. Observed months pass through unchanged. Future years (beyond the last observed) are projected with the <strong>Climate Delta Scaling Method</strong> (PAGASA&nbsp;2018, Region&nbsp;III): each month's robust baseline <em>Q<sub>base</sub>(m)</em> — the median of observed cms for that calendar month — is shifted by the projected seasonal rainfall change δ(m), ramped linearly from the 2010 baseline (φ=0) to 2050 (φ=1), and floored at ${RIVER_MIN_FLOW}&nbsp;cms so flows are never negative. The band is the ±${(RIVER_ENVELOPE*100).toFixed(0)}% planning envelope recommended for high-variability gauges.`);
    if (r.mk) {
      const dir = r.mk.S < 0 ? "declining" : r.mk.S > 0 ? "rising" : "flat";
      insights.push(`Mann-Kendall trend test on the observed annual means: Z = <strong>${r.mk.Z.toFixed(2)}</strong> (${dir} direction, ${r.mk.significant ? "<strong>significant</strong>" : "not significant"} at the 5% level). ` +
                    (r.mk.significant
                      ? `A data-derived decay could be justified; the climate-delta projection is used here as the non-negative, climate-grounded default.`
                      : `Per the methodology, an OLS/CAGR extrapolation of this insignificant noise slope would be invalid — the climate-delta method is the correct choice.`));
    }
    if (r.seasonalShape) {
      const peakIdx = r.seasonalShape.indexOf(Math.max(...r.seasonalShape));
      const dryIdx  = r.seasonalShape.indexOf(Math.min(...r.seasonalShape));
      const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      insights.push(`Observed seasonality peaks in <strong>${monthNames[peakIdx]}</strong> ` +
                    `(~${r.seasonalShape[peakIdx].toFixed(2)}× the yearly mean), ` +
                    `with a dry-season low in <strong>${monthNames[dryIdx]}</strong> ` +
                    `(~${r.seasonalShape[dryIdx].toFixed(2)}×).`);
    }
  }

  return insights;
}

//=========================================================================
// RENDER
//=========================================================================
function flagLabel(f) {
  if (f === "observed")        return '<span class="flag flag-observed">Observed</span>';
  if (f === "backcast_high")   return '<span class="flag flag-backcast_high">High confidence</span>';
  if (f === "backcast_mid")    return '<span class="flag flag-backcast_mid">Mid confidence</span>';
  if (f === "backcast_low")    return '<span class="flag flag-backcast_low">Low confidence</span>';
  if (f === "forecast")        return '<span class="flag flag-forecast">Projected</span>';
  if (f === "missing")         return '<span class="flag flag-missing">Missing</span>';
  return '<span class="flag flag-unsupported">' + f + '</span>';
}

function renderSummary(results) {
  const grid = $("#summaryGrid");
  const total = results.length;
  const supported = results.filter(r => r.supported).length;
  let obs = 0, bc = 0, fc = 0, miss = 0;
  for (const r of results) {
    if (!r.supported || !r.rows) continue;
    for (const y of Object.keys(r.rows)) {
      const f = r.rows[+y].flag;
      if (f === "observed") obs++;
      else if (f === "forecast") fc++;
      else if (f && f.startsWith("backcast")) bc++;
      else if (f === "missing") miss++;
    }
  }
  const horizon = `${STATE.rangeStart}–${STATE.rangeEnd}`;
  grid.innerHTML = `
    <div class="glass summary-card"><div class="label">Locations</div><div class="value">${total}</div><div class="sub">${supported} processed</div></div>
    <div class="glass summary-card"><div class="label">Observed cells</div><div class="value">${obs.toLocaleString()}</div><div class="sub">preserved as-is</div></div>
    <div class="glass summary-card"><div class="label">Gap-filled cells</div><div class="value">${bc.toLocaleString()}</div><div class="sub">station-substitution</div></div>
    <div class="glass summary-card"><div class="label">Projected cells</div><div class="value">${fc.toLocaleString()}</div><div class="sub">trend-extrapolated</div></div>
    <div class="glass summary-card"><div class="label">Horizon</div><div class="value">${horizon}</div><div class="sub">${STATE.granularity}</div></div>
  `;
}

function explainResult(r) {
  if (!r.supported) {
    return `<div class="alert alert-warn"><strong>Could not process:</strong> ${r.reason}</div>`;
  }
  const isTemplate = r.template === r.name;
  const parts = [];
  if (isTemplate) {
    parts.push(`<strong>${r.name}</strong> is the <strong>template series</strong> — the longest observed record in your upload. ` +
               `Its values pass through unchanged after annualisation.`);
  } else if (r.Rmedian != null) {
    parts.push(`<strong>${r.name}</strong> — backcasts derived from the ` +
               `<strong>${r.template}</strong> template via <code>LPCD/value(${r.name}) ÷ LPCD/value(${r.template})</code>, ` +
               `median R̂ = <strong>${r.Rmedian.toFixed(3)}</strong>, ` +
               `from <strong>${r.overlap}</strong> overlap year${r.overlap === 1 ? "" : "s"} ` +
               `(CV = ${(r.cv * 100).toFixed(1)}%). Tier: ${flagLabel(r.tier)}.`);
  }
  if (STATE.category === "riverflow" && (STATE.timeframe === "projected" || STATE.timeframe === "both")) {
    parts.push(`Projection: Climate Delta Scaling (PAGASA 2018, RCP4.5) on the observed monthly-median baseline; ±${(RIVER_ENVELOPE*100).toFixed(0)}% planning band; physical floor ${RIVER_MIN_FLOW} cms.`);
  } else if (r.trend && r.trend.n >= 2 && (STATE.timeframe === "projected" || STATE.timeframe === "both")) {
    parts.push(`Projection trend: slope = <strong>${fmt2(r.trend.slope)}</strong> per year, R² = ${r.trend.r2.toFixed(2)}, ` +
               `90% CI = ±${fmt2(1.645 * r.trend.seResid)} on the normalised scale.`);
  }
  return parts.length ? `<div class="explanation">${parts.join(" ")}</div>` : "";
}

function renderLocBlock(r) {
  const block = document.createElement("div");
  block.className = "glass loc-block";

  if (!r.supported) {
    block.innerHTML = `
      <div class="loc-header">
        <h3>${r.name || "Unknown column"}</h3>
        <span class="loc-meta">unsupported</span>
      </div>
      <div class="loc-body">${explainResult(r)}</div>`;
    return block;
  }

  const years = Object.keys(r.rows).map(Number).sort((a, b) => a - b);
  const granularity = STATE.granularity;
  const isWater = STATE.category === "water";
  const isRiver = STATE.category === "riverflow";
  const valHeader = isRiver ? "Mean cms" : isWater ? "Annual m³" : "Annual ha";
  const monthHeader = isRiver ? "Monthly cms" : isWater ? "Monthly m³" : "Monthly ha (avg)";
  // River-flow figures are small (~1–5 cms) so need decimals; others are integer-scale.
  const fmtV = isRiver ? fmt2 : fmtInt;

  // Build table rows — note Status column moved to LAST position.
  // Population column is meaningful for Urban Water Use (LPCD) only.
  const showPop = STATE.category === "water" && STATE.popMode === "with";
  let rowsHtml = "";

  if (granularity === "monthly") {
    // Twelve rows per year per location.
    for (const y of years) {
      const row = r.rows[y];
      const cls = row.flag === "forecast" ? "row-forecast"
                : (row.flag && row.flag.startsWith("backcast")) ? "row-backcast"
                : "";
      for (let m = 1; m <= 12; m++) {
        // River flow stays in cms: prefer the real monthly cms on observed
        // years; for missing months / years predict cms = year-mean × monthly
        // multiplier. Other categories broadcast annual ÷ 12.
        let v, lo, hi;
        if (isRiver) {
          if (row.monthly_cms && row.monthly_cms[m] != null) {
            v = row.monthly_cms[m];
            lo = row.value_lower90 != null && row.value_mean
              ? row.value_lower90 * (v / row.value_mean) : null;
            hi = row.value_upper90 != null && row.value_mean
              ? row.value_upper90 * (v / row.value_mean) : null;
          } else if (r.seasonalShape && row.value_mean != null) {
            const mult = r.seasonalShape[m - 1];
            v = row.value_mean * mult;
            lo = row.value_lower90 != null ? row.value_lower90 * mult : null;
            hi = row.value_upper90 != null ? row.value_upper90 * mult : null;
          } else {
            v = row.monthly_mean;
            lo = row.value_lower90; hi = row.value_upper90;
          }
        } else {
          v = row.monthly_mean;
          lo = row.value_lower90 != null ? row.value_lower90 / 12 : null;
          hi = row.value_upper90 != null ? row.value_upper90 / 12 : null;
        }
        rowsHtml += `<tr class="${cls}">
          <td>${y}-${String(m).padStart(2, "0")}</td>
          ${showPop ? `<td>${fmtInt(row.population)}</td>` : ""}
          <td>${fmtV(v)}</td>
          <td>${fmtV(lo)} – ${fmtV(hi)}</td>
          <td>${flagLabel(row.flag)}</td>
        </tr>`;
      }
    }
  } else {
    for (const y of years) {
      const row = r.rows[y];
      const cls = row.flag === "forecast" ? "row-forecast"
                : (row.flag && row.flag.startsWith("backcast")) ? "row-backcast"
                : "";
      // River flow: value_mean IS the monthly-mean cms, so the monthly column
      // mirrors it (not value_mean ÷ 12, which only makes sense for annual totals).
      const monthCell = isRiver ? row.value_mean : row.monthly_mean;
      rowsHtml += `<tr class="${cls}">
        <td>${y}</td>
        ${showPop ? `<td>${fmtInt(row.population)}</td>` : ""}
        <td>${fmtV(row.value_mean)}</td>
        <td>${fmtV(row.value_lower90)} – ${fmtV(row.value_upper90)}</td>
        <td>${fmtV(monthCell)}</td>
        <td>${flagLabel(row.flag)}</td>
      </tr>`;
    }
  }

  const headers = granularity === "monthly"
    ? `<th>Year-Month</th>${showPop ? "<th>Population</th>" : ""}<th>${monthHeader}</th><th>90% CI (monthly)</th><th>Status</th>`
    : `<th>Year</th>${showPop ? "<th>Population</th>" : ""}<th>${valHeader}</th><th>${valHeader} 90% CI</th><th>${monthHeader}</th><th>Status</th>`;

  // Interpretation
  const insights = interpretSeries(r, {
    category: STATE.category,
    timeframe: STATE.timeframe,
    popMode: STATE.popMode
  });

  block.innerHTML = `
    <div class="loc-header">
      <h3>${r.name}</h3>
      <span class="loc-meta">${
        r.template === r.name ? "template series" :
        r.tier ? `${r.tier.replace("backcast_", "")} tier · ${r.overlap} overlap yrs` :
        "trend-extrapolated"
      }</span>
    </div>
    <div class="loc-body">
      ${explainResult(r)}
      <div class="table-wrapper">
        <table class="fluxo-table">
          <thead><tr>${headers}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="interp">
        <h4>Automated interpretation</h4>
        <ul>${insights.map(s => `<li>${s}</li>`).join("")}</ul>
      </div>
    </div>`;
  return block;
}

//=========================================================================
// CSV EXPORT — strict wide format matching the upstream tooling spec.
//   Row 1: ;,,,..., (one trailing comma per location)
//   Row 2: ;,, + per-location units row
//   Row 3: ;Year,Month,Loc1,Loc2,...
//   Data: Year,Month,V1,V2,...
//=========================================================================
function monthlyValueFor(r, row, monthIdx) {
  // monthIdx: 1..12. Returns the monthly value (already in target units).
  if (!row || row.value_mean == null) return null;
  if (STATE.category === "riverflow") {
    // cms: real reading if observed, else year-mean × monthly multiplier.
    if (row.monthly_cms && row.monthly_cms[monthIdx] != null) return row.monthly_cms[monthIdx];
    if (r.seasonalShape) return row.value_mean * r.seasonalShape[monthIdx - 1];
    return row.value_mean;
  }
  return row.value_mean / 12;
}

function buildFilledCsv(results) {
  const supported = results.filter(r => r.supported);
  if (!supported.length) return "";

  const locNames = supported.map(r => r.name);
  const byName = {};
  for (const r of supported) byName[r.name] = r;

  // ---- Annual: tab-delimited wide yearly layout mirroring the source annual
  // files. 3-row header (group label, blank, ;Year + series), NO Month column,
  // one row per year. ----
  if (STATE.granularity === "annual") {
    const T = "\t";
    const N = locNames.length;
    const row1 = [";", STATE.datasetLabel || "", ...Array(Math.max(0, N - 1)).fill("")].join(T);
    const row2 = [";", ...Array(N).fill("")].join(T);
    const row3 = [";Year", ...locNames.map(tsvCell)].join(T);
    const lines = [row1, row2, row3];
    for (let y = STATE.rangeStart; y <= STATE.rangeEnd; y++) {
      const vals = locNames.map(n => {
        const row = byName[n].rows[y];
        return row ? fmtAnnualValue(row.value_mean) : "";
      });
      lines.push([y, ...vals].join(T));
    }
    return lines.join("\n");
  }

  // ---- Monthly: comma-delimited wide layout with a per-location units row. ----
  // Output unit per category: River Flow → cms, Urban Water Use → m³,
  // Agriculture → hectares.
  const unit = STATE.category === "agriculture" ? "ha"
             : STATE.category === "riverflow"   ? "cms"
             : "m3";
  // Row 1: ";" + N+1 commas ⇒ N+2 cells, all empty (first cell is just ";")
  const emptyHeader1 = ";" + ",".repeat(1 + locNames.length);
  // Row 2: ";,," + per-location unit cells ⇒ Year & Month placeholders blank, unit on each loc
  const unitsRow = ";,," + locNames.map(() => unit).join(",");
  // Row 3: ";Year,Month,Loc1,Loc2,..."
  const headerRow = ";Year,Month," + locNames.map(csvEscape).join(",");

  const lines = [emptyHeader1, unitsRow, headerRow];

  // Year range from STATE; for each year, emit 12 monthly rows.
  for (let y = STATE.rangeStart; y <= STATE.rangeEnd; y++) {
    for (let m = 1; m <= 12; m++) {
      const vals = locNames.map(n => {
        const r = byName[n];
        const row = r.rows[y];
        const v = monthlyValueFor(r, row, m);
        return v == null ? "" : v.toFixed(2);
      });
      lines.push(`${y},${m},${vals.join(",")}`);
    }
  }
  return lines.join("\n");
}

function csvEscape(s) {
  if (s == null) return "";
  const v = String(s);
  return /[,";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Tab-delimited cell — strip any tabs/newlines that would break the column grid.
function tsvCell(s) {
  return String(s == null ? "" : s).replace(/[\t\r\n]/g, " ");
}

// Annual CSV value: round to 4 dp, then strip trailing zeros (matches the
// precision/formatting of the source annual datasets, e.g. 24452.7090 → 24452.709).
function fmtAnnualValue(v) {
  if (v == null || isNaN(v)) return "";
  let s = v.toFixed(4);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function buildLongCsv(results) {
  // Long-format companion CSV with all status flags + CIs (separate from the strict wide CSV).
  const header = [
    "year", "month", "location", "status",
    "annual_mean", "annual_lower90", "annual_upper90",
    "monthly_mean", "population"
  ];
  const lines = [header.join(",")];
  for (const r of results) {
    if (!r.supported) continue;
    for (const y of Object.keys(r.rows).map(Number).sort((a, b) => a - b)) {
      const row = r.rows[y];
      for (let m = 1; m <= 12; m++) {
        lines.push([
          y, m, csvEscape(r.name), row.flag,
          row.value_mean   == null ? "" : row.value_mean.toFixed(2),
          row.value_lower90 == null ? "" : row.value_lower90.toFixed(2),
          row.value_upper90 == null ? "" : row.value_upper90.toFixed(2),
          row.monthly_mean == null ? "" : row.monthly_mean.toFixed(2),
          row.population   == null ? "" : Math.round(row.population)
        ].join(","));
      }
    }
  }
  return lines.join("\n");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function copyTableToClipboard(results) {
  // Tab-separated for paste into Excel — matches the chosen granularity.
  const supported = results.filter(r => r.supported);
  const locNames = supported.map(r => r.name);
  const byName = {};
  for (const r of supported) byName[r.name] = r;
  let lines;
  if (STATE.granularity === "annual") {
    lines = ["Year\t" + locNames.map(tsvCell).join("\t")];
    for (let y = STATE.rangeStart; y <= STATE.rangeEnd; y++) {
      const vals = locNames.map(n => {
        const row = byName[n].rows[y];
        return row ? fmtAnnualValue(row.value_mean) : "";
      });
      lines.push(`${y}\t${vals.join("\t")}`);
    }
  } else {
    lines = ["Year\tMonth\t" + locNames.map(tsvCell).join("\t")];
    for (let y = STATE.rangeStart; y <= STATE.rangeEnd; y++) {
      for (let m = 1; m <= 12; m++) {
        const vals = locNames.map(n => {
          const r = byName[n];
          const v = monthlyValueFor(r, r.rows[y], m);
          return v == null ? "" : v.toFixed(2);
        });
        lines.push(`${y}\t${m}\t${vals.join("\t")}`);
      }
    }
  }
  const text = lines.join("\n");
  navigator.clipboard.writeText(text).then(() => {
    alert(`Copied ${lines.length - 1} rows × ${locNames.length} ${locNames.length === 1 ? "series" : "series"} to clipboard.`);
  }).catch(err => alert("Copy failed: " + err.message));
}

function buildHtmlReport(results, originalFilename) {
  const ts = new Date().toLocaleString();
  const category = STATE.category === "water" ? "Urban Water Use"
                 : STATE.category === "riverflow" ? "River Flow / Streamflow (cms)"
                 : "Agricultural Crop Planted/Harvested";
  const timeframe = STATE.timeframe === "projected" ? "Projected Data (2025–2050)"
                  : STATE.timeframe === "both"      ? "Both — Historical + Projected (2000–2050)"
                  : "Current Data (2000–2024)";
  const granularity = STATE.granularity === "monthly" ? "Monthly" : "Annual";
  const popMode = STATE.category === "agriculture"
                  ? (STATE.popMode === "with" ? "Land-area disaggregation from a parent-area total" : "Direct per-location values")
                  : STATE.category === "riverflow" ? "Direct cms processing"
                  : (STATE.popMode === "with" ? "Population data provided (LPCD)" : "Population data not provided");

  let body = `
    <h1>Fluxo Analysis Report</h1>
    <p><em>College of Climate Change and Environmental Management · Central Luzon State University</em></p>
    <hr/>
    <p><strong>File:</strong> ${originalFilename}</p>
    <p><strong>Generated:</strong> ${ts}</p>
    <p><strong>Category:</strong> ${category}</p>
    <p><strong>Timeframe:</strong> ${timeframe}</p>
    <p><strong>Granularity:</strong> ${granularity}</p>
    <p><strong>Reference mode:</strong> ${popMode}</p>
    <p><strong>Method:</strong> ${STATE.category === "riverflow"
      ? "Station-substitution (MOVE / Hirsch 1982) for gap-fill; forward projection by Climate Delta Scaling (PAGASA 2018 Region III RCP4.5) on the observed monthly-median baseline, ramped linearly 2010→2050, floored at " + RIVER_MIN_FLOW + " cms; ±" + (RIVER_ENVELOPE*100).toFixed(0) + "% planning band. Mann-Kendall reported per series."
      : "Station-substitution (MOVE / Hirsch 1982) using the longest observed series in the upload as the template; trend extrapolation via OLS for projection; per-tier empirically calibrated 90% intervals."}</p>
  `;
  for (const r of results) {
    if (!r.supported) {
      body += `<h2>${r.name}</h2><p style="color:#9a2c2c;">${r.reason}</p>`;
      continue;
    }
    body += `<h2>${r.name}</h2>`;
    if (r.template === r.name) {
      body += `<p><em>Template series — values pass through unchanged.</em></p>`;
    } else if (r.Rmedian != null) {
      body += `<p>Template: <strong>${r.template}</strong>; overlap: <strong>${r.overlap}</strong> yrs; ` +
              `CV(R)=${(r.cv * 100).toFixed(1)}%; R̂=${r.Rmedian.toFixed(3)}; tier: <strong>${r.tier}</strong>.</p>`;
    }
    body += `<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:13px;">
      <thead><tr><th>Year</th><th>Population</th><th>Annual</th><th>90% CI</th><th>Monthly avg</th><th>Status</th></tr></thead><tbody>`;
    const years = Object.keys(r.rows).map(Number).sort((a, b) => a - b);
    for (const y of years) {
      const row = r.rows[y];
      body += `<tr>
        <td>${y}</td>
        <td>${fmtInt(row.population)}</td>
        <td>${fmtInt(row.value_mean)}</td>
        <td>${fmtInt(row.value_lower90)} – ${fmtInt(row.value_upper90)}</td>
        <td>${fmtInt(row.monthly_mean)}</td>
        <td>${row.flag}</td>
      </tr>`;
    }
    body += `</tbody></table>`;

    const insights = interpretSeries(r, {
      category: STATE.category, timeframe: STATE.timeframe, popMode: STATE.popMode
    });
    body += `<h3 style="font-size:14px;color:#0d4a2f;">Automated interpretation</h3><ul>` +
            insights.map(s => `<li>${s}</li>`).join("") + `</ul>`;
  }
  body += `<hr/><p style="text-align:center;font-style:italic;color:#0d4a2f;">Developed by Jerome N. Ancheta – UST and Elijah C. Flora – CLSU.</p>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fluxo Report</title>
    <style>
      body{font-family:'Inter',-apple-system,sans-serif;max-width:1100px;margin:24px auto;padding:0 18px;color:#0f2118;}
      h1{color:#052e1c;font-family:Georgia,serif;}
      h2{color:#0d4a2f;border-bottom:1px solid #cce5d5;padding-bottom:4px;margin-top:30px;}
      table{font-size:13px;width:100%;margin-top:8px;}
      thead th{background:#e9f5f0;color:#0d4a2f;text-align:left;padding:6px;}
      td{padding:4px 6px;}
    </style></head><body>${body}</body></html>`;
}

//=========================================================================
// WIZARD UI WIRING
//=========================================================================
function updateStepper(currentStep) {
  $$("#stepper .step").forEach(el => {
    const n = +el.dataset.step;
    el.classList.remove("active", "done");
    if (n < currentStep) el.classList.add("done");
    else if (n === currentStep) el.classList.add("active");
  });
  $$(".step-panel").forEach(p => p.classList.toggle("active", +p.dataset.panel === currentStep));
}

function currentStep() {
  const active = $(".step-panel.active");
  return active ? +active.dataset.panel : 1;
}

function canAdvance(stepNum) {
  if (stepNum === 1) return !!STATE.category;
  if (stepNum === 2) return !!STATE.timeframe;
  if (stepNum === 3) return !!STATE.granularity;
  if (stepNum === 4) return !!STATE.popMode;
  return false;
}

function refreshNextButtons() {
  $$(".step-panel").forEach(p => {
    const n = +p.dataset.panel;
    const btn = p.querySelector('[data-action="next"]');
    if (btn) btn.disabled = !canAdvance(n);
  });
  refreshRunButton();
}

function refreshRunButton() {
  const ok = STATE.fileMain && (STATE.popMode === "without" || (STATE.popMode === "with" && STATE.filePop));
  $("#runBtn").disabled = !ok;
}

function applyStep4Copy() {
  // Step 4 question copy adapts to category.
  if (STATE.category === "agriculture") {
    $("#popQuestion").textContent = "How should the platform obtain per-location crop data?";
    $("#popHelp").innerHTML = `If you only have a <strong>parent-area total</strong> (e.g. a whole province or region),
      the platform can split it into per-municipality estimates by <strong>land-area share</strong>:
      <code>share = area_ha ÷ parent_total_ha</code>, then <code>value = parent_total × share</code>.
      If you already have per-location values, it works with them directly.`;
    $("#popYesTitle").textContent = "Disaggregate from a parent-area total";
    $("#popYesDesc").textContent = "Upload parent crop totals + a land-area table (ha). The platform computes each area's share and splits the totals.";
    $("#popNoTitle").textContent = "I already have per-location values";
    $("#popNoDesc").textContent = "Direct station-substitution and trend extrapolation on the values you upload.";
  } else if (STATE.category === "riverflow") {
    $("#popQuestion").textContent = "River flow processing — no reference data required.";
    $("#popHelp").innerHTML = `River discharge stays in <strong>cms (m³/s)</strong>. The platform predicts only the
      <strong>missing cms values</strong> — gap-filling missing months/years and projecting forward — while observed
      readings pass through unchanged. No per-capita normalisation applies. Select <em>Process directly</em> to continue.`;
    $("#popYesTitle").textContent = "Apply a reference multiplier (rare)";
    $("#popYesDesc").textContent = "Reserved for catchment-area scaling. Upload a matching reference file in the next step.";
    $("#popNoTitle").textContent = "Process directly (recommended)";
    $("#popNoDesc").textContent = "Gap-fill missing cms and project to 2050 via Climate Delta Scaling (PAGASA 2018). Observed months preserved.";
  } else {
    $("#popQuestion").textContent = "Do you have reference population data?";
    $("#popHelp").innerHTML = `If population data is available, the platform will compute litres-per-capita-per-day (LPCD) and use it to
      backcast or project demand more accurately. If not, the platform will work directly with the demand values.
      Either way, <strong>no external population data is used</strong> — only what you upload.`;
    $("#popYesTitle").textContent = "Yes — I will upload population data";
    $("#popYesDesc").textContent = "Per-capita normalisation. A second upload slot will appear in the next step.";
    $("#popNoTitle").textContent = "No — work directly with the values";
    $("#popNoDesc").textContent = "Direct station-substitution and trend extrapolation, no per-capita step.";
  }
}

function applyStep5Copy() {
  const isAgriDisagg = STATE.category === "agriculture" && STATE.popMode === "with";
  const cat = STATE.category === "agriculture" ? "Crop planted/harvested"
            : STATE.category === "riverflow"   ? "River flow (cms)"
            : "Water demand";
  $("#mainLabel").textContent = isAgriDisagg ? "Parent-area crop totals" : `${cat} dataset`;
  const helpBits = [
    "Provide a wide-format CSV/XLSX (Year, Month, Loc1, Loc2, …). Empty cells are treated as missing values."
  ];
  if (isAgriDisagg) {
    helpBits.push("The main file holds the parent-area crop totals; the second file is the land-area table.");
  }
  if (STATE.category === "riverflow") {
    helpBits.push("Discharge stays in cms (m³/s); only missing months and years are predicted.");
  }
  if (STATE.timeframe === "projected" || STATE.timeframe === "both") {
    helpBits.push(STATE.category === "riverflow"
      ? "Output horizon extends to 2050 via Climate Delta Scaling (PAGASA 2018 RCP4.5)."
      : "Output horizon will extend to 2050 using fitted trend extrapolation.");
  }
  if (STATE.category === "water" && STATE.popMode === "with") {
    helpBits.push("Upload the matching population/reference file in the second slot.");
  }
  $("#uploadHelp").innerHTML = helpBits.join(" ");

  // Adapt the second-slot labels (land-area table vs population/reference).
  if (isAgriDisagg) {
    $("#popLabel").textContent = "Land-area table (Area, hectares)";
    $("#popSecondary").textContent = "Two columns: area name + land area in ha. A header row is skipped automatically.";
  } else {
    $("#popLabel").textContent = "Population / Reference dataset";
    $("#popSecondary").textContent = "Same wide format · matching Year/Month/Location columns";
  }

  // Toggle second upload slot + the parent-total input (agri disaggregation only).
  const popZone = $("#dropzonePop");
  const row = $("#uploadRow");
  $("#parentTotalWrap").classList.toggle("hidden", !isAgriDisagg);
  if (STATE.popMode === "with") {
    popZone.classList.remove("hidden");
    row.classList.remove("single");
  } else {
    popZone.classList.add("hidden");
    row.classList.add("single");
  }
}

function selectOpt(el) {
  const key = el.dataset.key;
  const value = el.dataset.value;
  STATE[key] = value;
  // Mark sibling options.
  el.parentElement.querySelectorAll(".opt").forEach(o => o.classList.toggle("selected", o === el));
  if (key === "category") applyStep4Copy();
  if (key === "popMode") applyStep5Copy();
  if (key === "timeframe") {
    // Pre-set horizon (visual cue purposes).
    const h = horizonFor(STATE.timeframe);
    STATE.rangeStart = h.start;
    STATE.rangeEnd   = h.end;
  }
  refreshNextButtons();
}

function attachOptHandlers() {
  $$(".opt").forEach(el => el.addEventListener("click", () => selectOpt(el)));
}

function attachStepNav() {
  $$('[data-action="next"]').forEach(b => b.addEventListener("click", () => {
    const cur = currentStep();
    if (canAdvance(cur)) {
      if (cur + 1 === 5) applyStep5Copy();
      updateStepper(cur + 1);
    }
  }));
  $$('[data-action="back"]').forEach(b => b.addEventListener("click", () => {
    const cur = currentStep();
    if (cur > 1) updateStepper(cur - 1);
  }));
  $$('[data-action="reset"]').forEach(b => b.addEventListener("click", () => resetAll()));
}

function resetAll() {
  STATE.category = STATE.timeframe = STATE.granularity = STATE.popMode = null;
  STATE.fileMain = STATE.filePop = null;
  STATE.parentTotalHa = null;
  STATE.datasetLabel = "";
  STATE.results = null;
  $$(".opt").forEach(o => o.classList.remove("selected"));
  $("#mainPill").innerHTML = "";
  $("#popPill").innerHTML  = "";
  $("#fileMain").value = "";
  $("#filePop").value  = "";
  if ($("#parentTotalHa")) $("#parentTotalHa").value = "";
  $("#parentTotalWrap").classList.add("hidden");
  $("#resultsSection").classList.add("hidden");
  $("#processingSection").classList.add("hidden");
  updateStepper(1);
  refreshNextButtons();
  document.getElementById("workflow").scrollIntoView({ behavior: "smooth", block: "start" });
}

//=========================================================================
// FILE UPLOAD WIRING
//=========================================================================
function bindDropzone(zoneEl, inputEl, pillEl, onFile) {
  zoneEl.addEventListener("dragover", e => { e.preventDefault(); zoneEl.classList.add("dragover"); });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("dragover"));
  zoneEl.addEventListener("drop", e => {
    e.preventDefault();
    zoneEl.classList.remove("dragover");
    if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
  });
  inputEl.addEventListener("change", e => {
    if (e.target.files.length) onFile(e.target.files[0]);
  });
}

function setPill(pillEl, file, ok = true) {
  pillEl.innerHTML = `<span class="file-pill ${ok ? "" : "error"}"><svg class="icon-svg" style="width:15px;height:15px"><use href="#i-file-text"/></svg>${escapeHtml(file.name)} · ${(file.size / 1024).toFixed(1)} KB</span>`;
}

//=========================================================================
// RUN BUTTON
//=========================================================================
async function executeRun() {
  $("#processingSection").classList.remove("hidden");
  $("#resultsSection").classList.add("hidden");
  $("#runBtn").disabled = true;

  try {
    const { results } = await runPipeline();
    STATE.results = results;
    $("#processingSection").classList.add("hidden");
    renderSummary(results);
    const container = $("#resultsContainer");
    container.innerHTML = "";
    for (const r of results) container.appendChild(renderLocBlock(r));
    $("#resultsSection").classList.remove("hidden");
    $("#resultsSection").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    $("#processingSection").classList.add("hidden");
    showRunError(err);
    console.error(err);
  } finally {
    refreshRunButton();
  }
}

// Render a friendly, actionable error in the run zone.
function showRunError(err) {
  $$("#runZone .alert-err").forEach(el => el.remove()); // clear previous
  const fileName = (STATE.fileMain && STATE.fileMain.name) ? ` (${escapeHtml(STATE.fileMain.name)})` : "";
  const message = err && err.userFacing
    ? escapeHtml(err.message)
    : `Something went wrong while reading your file${fileName}.`;
  const hint = err && err.hint
    ? err.hint
    : "Please upload a CSV or XLSX in the wide format shown in Step 5. If the problem persists, check that the file isn’t empty, password-protected, or a different export than expected.";

  let html = `<strong>We couldn’t run the analysis.</strong>` +
             `<div style="margin-top:6px;">${message}</div>` +
             `<div style="margin-top:8px;">${hint}</div>`;
  if (err && err.example) {
    html += `<div style="margin-top:10px; font-weight:600;">Expected layout</div>` +
            `<pre style="margin-top:4px; padding:10px 12px; border-radius:8px; ` +
            `background:rgba(0,0,0,0.05); overflow:auto; font-size:0.82rem; line-height:1.5;">` +
            `${escapeHtml(err.example)}</pre>`;
  }
  const div = document.createElement("div");
  div.className = "alert alert-err";
  div.innerHTML = html;
  $("#runZone").appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "center" });
}

//=========================================================================
// BOOT
//=========================================================================
function boot() {
  // Year in footer.
  const yEl = document.getElementById("year");
  if (yEl) yEl.textContent = new Date().getFullYear();

  attachOptHandlers();
  attachStepNav();
  refreshNextButtons();
  applyStep4Copy();

  bindDropzone($("#dropzoneMain"), $("#fileMain"), $("#mainPill"), (f) => {
    STATE.fileMain = f;
    setPill($("#mainPill"), f, true);
    refreshRunButton();
  });
  bindDropzone($("#dropzonePop"), $("#filePop"), $("#popPill"), (f) => {
    STATE.filePop = f;
    setPill($("#popPill"), f, true);
    refreshRunButton();
  });

  const parentInput = $("#parentTotalHa");
  if (parentInput) {
    parentInput.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      STATE.parentTotalHa = (!isNaN(v) && v > 0) ? v : null;
    });
  }

  $("#runBtn").addEventListener("click", executeRun);

  $("#downloadBtn").addEventListener("click", () => {
    if (!STATE.results) return;
    const baseName = (STATE.fileMain && STATE.fileMain.name) ? STATE.fileMain.name.replace(/\.[^.]+$/, "") : "fluxo";
    downloadBlob(buildFilledCsv(STATE.results), `${baseName}_filled.csv`, "text/csv");
  });
  $("#copyBtn").addEventListener("click", () => {
    if (!STATE.results) return;
    copyTableToClipboard(STATE.results);
  });
  $("#downloadReportBtn").addEventListener("click", () => {
    if (!STATE.results) return;
    const baseName = (STATE.fileMain && STATE.fileMain.name) ? STATE.fileMain.name : "fluxo";
    downloadBlob(buildHtmlReport(STATE.results, baseName), `${baseName.replace(/\.[^.]+$/, "")}_report.html`, "text/html");
  });

  // Reveal-on-scroll.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("visible");
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.12 });
  $$(".reveal").forEach(el => io.observe(el));
}

document.addEventListener("DOMContentLoaded", boot);
