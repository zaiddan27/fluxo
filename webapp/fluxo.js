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
  category: null,      // "water" | "riverflow"
  timeframe: null,     // "current" | "projected" | "both"
  granularity: null,   // "annual" | "monthly"
  fileMain: null,
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
// ANNUALISE (river flow)
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
// URBAN WATER — semester-based gap-fill + projection (Urban Water Methodology)
//
// Urban water extraction is modelled per STATION, independently for each
// SEMESTER (S1 = Jan–Jun dry season, S2 = Jul–Dec wet season), then broadcast
// back to the six months of that semester. There is NO population / per-capita
// step (none exists in the methodology); the method is fully data-driven and
// applies to any Philippine location.
//   • Phase 1 (historical gap-fill): geometric / CAGR — leading gaps back-cast
//     from the global rate, interior gaps by local CAGR (linear fallback for
//     ≤0 brackets), all held above a physical floor = max(1, 5% of V_first).
//   • Phase 2 (projection, y > last observed): a model chosen by data
//     diagnostics — Quadratic (constant 2nd differences ⇒ constant
//     acceleration), CAGR-exact (perfect geometric series), Log-linear
//     (R²_log beats R²_lin), else Linear OLS (minimum-variance trend). ≥ 0.
//=========================================================================
const WATER_FLOOR_FRAC = 0.05;   // safety floor = 5% of first observed value
const WATER_QUAD_TOL   = 0.05;   // max CoV of 2nd differences to accept "quadratic"
const WATER_GEO_TOL    = 0.01;   // max CoV of YoY ratios to accept "CAGR-exact"
const WATER_LOGLIN_ADV = 0.02;   // R²_log must beat R²_lin by this to pick log-linear
const WATER_LOGLIN_MINR2 = 0.90; // …and the exponential fit must itself be strong
const WATER_MAX_GROWTH = 0.15;   // cap geometric growth at 15%/yr (anti-runaway safety)

// Split a station's monthly records into per-year semester values.
// S1 = mean of observed months 1–6, S2 = mean of months 7–12. A year with data
// in only one semester (or annual-only input) reuses that value for both.
function semesterObservations(records) {
  const acc = {};
  for (const rec of records) {
    if (rec.value == null) continue;
    const sem = rec.month <= 6 ? 1 : 2;
    (acc[rec.year] = acc[rec.year] || { 1: [], 2: [] })[sem].push(rec.value);
  }
  const out = { 1: {}, 2: {} };
  for (const y of Object.keys(acc)) {
    const o = acc[+y];
    const m1 = o[1].length ? mean(o[1]) : null;
    const m2 = o[2].length ? mean(o[2]) : null;
    out[1][+y] = m1 != null ? m1 : m2;
    out[2][+y] = m2 != null ? m2 : m1;
  }
  return out;
}

// Choose & fit the Phase-2 projection model for one observed semester series.
function selectWaterModel(years, vals) {
  const t = years, V = vals, n = V.length;
  const ratios = [];
  for (let i = 0; i < n - 1; i++) if (V[i] > 0) ratios.push(V[i + 1] / V[i]);
  const rMean = mean(ratios);
  const rCov = ratios.length > 1 ? stdev(ratios) / Math.abs(rMean) : Infinity;

  // Rule 1 — Quadratic: a trailing run (≥4 pts) with near-constant, positive
  // 2nd differences. Constant acceleration ⇒ the value series is exactly
  // quadratic; project by cumulating the linearly-growing annual increment.
  for (let st = 0; st <= n - 4; st++) {
    const seg = V.slice(st);
    const d1 = []; for (let i = 0; i < seg.length - 1; i++) d1.push(seg[i + 1] - seg[i]);
    const d2 = []; for (let i = 0; i < d1.length - 1; i++) d2.push(d1[i + 1] - d1[i]);
    if (d2.length < 2) continue;
    const m2 = mean(d2);
    if (m2 > 0 && stdev(d2) / Math.abs(m2) < WATER_QUAD_TOL) {
      const ty = t.slice(st + 1);
      const inc = ols(ty.map(y => y - ty[0]), d1);   // ΔV(τ) = α + β·τ
      if (inc) return { kind: "quadratic", alpha: inc.intercept, beta: inc.slope,
                        t0: ty[0], vLast: V[n - 1], tLast: t[n - 1] };
    }
  }
  // Rule 3 — CAGR-exact: a (near-)perfect geometric sequence over all years.
  if (rCov < WATER_GEO_TOL && V[0] > 0 && V[n - 1] > 0) {
    const r = Math.min(1 + WATER_MAX_GROWTH, Math.pow(V[n - 1] / V[0], 1 / (t[n - 1] - t[0])));
    return { kind: "cagr", r, vLast: V[n - 1], tLast: t[n - 1] };
  }
  // Rule 2 — Log-linear, but only for a genuinely strong, clearly-better
  // exponential fit (the doc reserves it for rapidly-urbanising stations like
  // San Miguel). Otherwise Rule 4 — Linear OLS (minimum-variance trend), the
  // documented default that avoids over-projecting noisy series.
  const lin = ols(t, V);
  if (V.every(v => v > 0)) {
    const log = ols(t, V.map(v => Math.log(v)));
    if (log && lin && log.r2 > lin.r2 + WATER_LOGLIN_ADV && log.r2 >= WATER_LOGLIN_MINR2
        && Math.exp(log.slope) - 1 <= WATER_MAX_GROWTH)
      return { kind: "loglinear", a: log.slope, b: log.intercept };
  }
  return { kind: "linear", a: lin ? lin.slope : 0, b: lin ? lin.intercept : V[n - 1] };
}

function waterModelLabel(m) {
  if (!m) return "—";
  if (m.kind === "quadratic") return "Quadratic OLS (constant 2nd differences)";
  if (m.kind === "cagr")      return `CAGR-exact (${((m.r - 1) * 100).toFixed(2)}%/yr)`;
  if (m.kind === "loglinear") return `Log-linear OLS (${((Math.exp(m.a) - 1) * 100).toFixed(2)}%/yr)`;
  return `Linear OLS (${m.a >= 0 ? "+" : ""}${Math.round(m.a).toLocaleString()} m³/yr)`;
}

function predictWater(model, year) {
  if (model.kind === "linear")    return model.a * year + model.b;
  if (model.kind === "loglinear") return Math.exp(model.a * year + model.b);
  if (model.kind === "cagr")      return model.vLast * Math.pow(model.r, year - model.tLast);
  return null;   // quadratic is cumulative — resolved by the caller
}

// Gap-fill (Phase 1) + project (Phase 2) one semester series across [start..end].
function fillProjectSemester(obs, start, end) {
  const oy = Object.keys(obs).map(Number).filter(y => obs[y] != null).sort((a, b) => a - b);
  if (!oy.length) return { values: {}, flags: {}, model: null };
  const firstObs = oy[0], lastObs = oy[oy.length - 1];
  const vFirst = obs[firstObs], vLast = obs[lastObs];
  const floor = Math.max(1, vFirst * WATER_FLOOR_FRAC);
  const gR = (vFirst > 0 && vLast > 0 && lastObs > firstObs)
    ? Math.pow(vLast / vFirst, 1 / (lastObs - firstObs)) : 1;   // global CAGR for back-cast

  const model = selectWaterModel(oy, oy.map(y => obs[y]));

  // Quadratic projection is a cumulative integral from the last observed year.
  const quadPath = {};
  if (model.kind === "quadratic") {
    let prev = model.vLast;
    for (let y = model.tLast + 1; y <= end; y++) {
      prev += model.alpha + model.beta * (y - model.t0);
      quadPath[y] = prev;
    }
  }

  const values = {}, flags = {};
  for (let y = start; y <= end; y++) {
    if (obs[y] != null) { values[y] = obs[y]; flags[y] = "observed"; continue; }
    if (y < firstObs) {                                  // leading back-cast
      values[y] = Math.max(vFirst / Math.pow(gR, firstObs - y), floor);
      flags[y] = "backcast_mid"; continue;
    }
    if (y > lastObs) {                                   // forward projection
      const v = model.kind === "quadratic" ? quadPath[y] : predictWater(model, y);
      values[y] = Math.max(0, v == null ? 0 : v); flags[y] = "forecast"; continue;
    }
    // interior gap — local CAGR between nearest bracketing observations.
    let lo = null, hi = null;
    for (let k = y - 1; k >= firstObs; k--) if (obs[k] != null) { lo = k; break; }
    for (let k = y + 1; k <= lastObs; k++) if (obs[k] != null) { hi = k; break; }
    if (lo != null && hi != null) {
      const vlo = obs[lo], vhi = obs[hi];
      const v = (vlo > 0 && vhi > 0)
        ? vlo * Math.pow(Math.pow(vhi / vlo, 1 / (hi - lo)), y - lo)
        : vlo + (vhi - vlo) * (y - lo) / (hi - lo);      // linear fallback for ≤0
      values[y] = Math.max(v, floor); flags[y] = "backcast_mid";
    }
  }
  return { values, flags, model };
}

function combineWaterFlag(f1, f2) {
  const fs = [f1, f2].filter(Boolean);
  if (!fs.length) return "missing";
  if (fs.includes("forecast")) return "forecast";
  if (fs.every(f => f === "observed")) return "observed";
  return "backcast_mid";
}

function processWaterSeries(s) {
  const start = STATE.rangeStart, end = STATE.rangeEnd;
  const sem = semesterObservations(s.records);
  const obsYears = new Set([...Object.keys(sem[1]), ...Object.keys(sem[2])].map(Number));
  if (!obsYears.size) {
    return { supported: false, name: s.name,
      reason: "This column has no numeric values, so there's nothing to gap-fill or project. Add at least one observed value, or remove the empty column." };
  }
  const r1 = fillProjectSemester(sem[1], start, end);
  const r2 = fillProjectSemester(sem[2], start, end);

  const rows = {};
  for (let y = start; y <= end; y++) {
    const v1 = r1.values[y], v2 = r2.values[y];
    if (v1 == null && v2 == null) {
      rows[y] = { year: y, value_mean: null, value_lower90: null, value_upper90: null,
                  monthly_mean: null, flag: "missing", population: null, norm_mean: null };
      continue;
    }
    const s1 = v1 != null ? v1 : v2, s2 = v2 != null ? v2 : v1;
    const annual = s1 + s2;                       // semi-annual total (doc §6 convention)
    const mv = {};
    for (let m = 1; m <= 12; m++) mv[m] = Math.max(0, Math.round(m <= 6 ? s1 : s2));
    const flag = combineWaterFlag(r1.flags[y], r2.flags[y]);
    const band = flag === "observed" ? 0 : 0.10;  // modest planning band on estimates
    rows[y] = {
      year: y, value_mean: annual,
      value_lower90: Math.max(0, annual * (1 - band)),
      value_upper90: annual * (1 + band),
      monthly_mean: annual / 12, monthly_vals: mv,
      flag, population: null, norm_mean: annual
    };
  }
  return {
    supported: true, name: s.name, rows,
    overlap: 0, cv: null, Rmedian: null, tier: null, template: null, trend: null,
    waterModelS1: r1.model, waterModelS2: r2.model
  };
}

//=========================================================================
// GAP-FILL (CURRENT) + PROJECTION  — river flow (and generic fallback)
//=========================================================================
function processSeries(s, template, templateAnnual, _unused, opts) {
  const { timeframe, category } = opts;
  const start = STATE.rangeStart;
  const end = STATE.rangeEnd;

  // Observed years for this series (river-flow annual mean cms).
  const ys = Object.keys(s.annual).map(Number).filter(y => s.annual[y].annual != null).sort((a, b) => a - b);
  if (!ys.length) {
    return { supported: false, name: s.name, reason: "This column has no numeric values, so there's nothing to gap-fill or project. Add at least one observed value, or remove the empty column." };
  }
  const firstObs = ys[0];
  const lastObs  = ys[ys.length - 1];

  // Observed series (no normalisation — river flow stays in cms throughout).
  const obsNorm = {};
  for (const y of ys) obsNorm[y] = s.annual[y].annual;
  const obsNormYears = ys.slice();

  // Template series for the pre-record back-cast (longest record in the upload).
  const tplNorm = {};
  if (template) {
    for (const y of Object.keys(templateAnnual).map(Number)) {
      const av = templateAnnual[y].annual;
      if (av != null) tplNorm[y] = av;
    }
  }

  // Back-cast ratios against the template (only when this series ≠ template).
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

  const trend = obsNormYears.length >= 2
    ? ols(obsNormYears, obsNormYears.map(y => obsNorm[y]))
    : null;

  const rows = {};
  const Z90 = 1.645;

  for (let y = start; y <= end; y++) {
    const observedAnnual = s.annual[y]?.annual ?? null;

    // 1) Observed pass-through.
    if (observedAnnual != null) {
      rows[y] = {
        year: y, value_mean: observedAnnual,
        value_lower90: observedAnnual, value_upper90: observedAnnual,
        monthly_mean: observedAnnual / 12, flag: "observed",
        population: null, norm_mean: observedAnnual
      };
      continue;
    }

    // 2) Pre-record back-cast — template ratio.
    if (y < firstObs && Rmed != null && tplNorm[y] != null) {
      const val_mean = Math.max(0, Rmed * tplNorm[y]);
      const tierQ = TIERS[tier] || TIERS.backcast_low;
      rows[y] = {
        year: y, value_mean: val_mean,
        value_lower90: Math.max(0, val_mean * (1 + tierQ.q05)),
        value_upper90: val_mean * (1 + tierQ.q95),
        monthly_mean: val_mean / 12, flag: tier,
        population: null, norm_mean: val_mean
      };
      continue;
    }

    // 3) Forward projection — Climate Delta Scaling (PAGASA 2018, RCP4.5). The
    // observed monthly-median seasonal pattern is shifted by the projected
    // seasonal rainfall change, ramped linearly 2010→2050; non-negative by
    // construction (physical floor). This is the documented Bulacan river method.
    if (y > lastObs && s.baseMonthlyMedian) {
      const phi = climatePhi(y);
      const mcms = {};
      let sum = 0, cnt = 0;
      for (let m = 1; m <= 12; m++) {
        const qb = s.baseMonthlyMedian[m - 1];
        if (qb == null) continue;
        mcms[m] = Math.max(qb * (1 + climateDelta("BASE", m) * phi), RIVER_MIN_FLOW);
        sum += mcms[m]; cnt++;
      }
      if (cnt > 0) {
        const val_mean = sum / cnt;
        rows[y] = {
          year: y, value_mean: val_mean,
          value_lower90: val_mean * (1 - RIVER_ENVELOPE),
          value_upper90: val_mean * (1 + RIVER_ENVELOPE),
          monthly_mean: val_mean / 12, monthly_cms: mcms,
          flag: "forecast", population: null, norm_mean: val_mean
        };
        continue;
      }
    }

    // 3b) Forward projection fallback (no baseline available) — floored OLS trend.
    if (y > lastObs && trend) {
      const val_mean = Math.max(0, trend.intercept + trend.slope * y);
      rows[y] = {
        year: y, value_mean: val_mean,
        value_lower90: Math.max(0, val_mean - Z90 * trend.seResid),
        value_upper90: val_mean + Z90 * trend.seResid,
        monthly_mean: val_mean / 12, flag: "forecast",
        population: null, norm_mean: val_mean
      };
      continue;
    }

    // 3c) Interior gap — linearly interpolate between bracketing observed years.
    if (y > firstObs && y < lastObs) {
      let yLow = null, yHigh = null;
      for (let k = y - 1; k >= firstObs; k--) if (s.annual[k]?.annual != null) { yLow = k; break; }
      for (let k = y + 1; k <= lastObs; k++) if (s.annual[k]?.annual != null) { yHigh = k; break; }
      if (yLow != null && yHigh != null) {
        const val_mean = Math.max(0, obsNorm[yLow] + (obsNorm[yHigh] - obsNorm[yLow]) * (y - yLow) / (yHigh - yLow));
        rows[y] = {
          year: y, value_mean: val_mean,
          value_lower90: val_mean * 0.88, value_upper90: val_mean * 1.12,
          monthly_mean: val_mean / 12, flag: "backcast_mid",
          population: null, norm_mean: val_mean
        };
        continue;
      }
    }

    // 4) Truly missing.
    rows[y] = {
      year: y, value_mean: null, value_lower90: null, value_upper90: null,
      monthly_mean: null, flag: "missing", population: null, norm_mean: null
    };
  }

  // Preserve the actual per-month cms on observed years (renderers / exporters
  // predict cms for missing months from the seasonal multiplier).
  if (s.seasonalShape) {
    for (const y of Object.keys(rows).map(Number)) {
      const obs = s.annual[y];
      if (obs && obs.monthly_cms && rows[y].flag === "observed") rows[y].monthly_cms = obs.monthly_cms;
    }
  }

  return {
    supported: true, name: s.name, rows,
    overlap: ratios.length, cv: Rcv, Rmedian: Rmed, tier,
    template: template ? template.name : null, trend,
    seasonalShape: s.seasonalShape || null,
    baseMonthlyMedian: s.baseMonthlyMedian || null,
    mk: s.mk || null
  };
}

//=========================================================================
// PIPELINE ENTRY
//=========================================================================
async function runPipeline() {
  // Horizon depends on timeframe choice.
  const horizon = horizonFor(STATE.timeframe);
  STATE.rangeStart = horizon.start;
  STATE.rangeEnd   = horizon.end;

  // Parse main file → one series per data column.
  const mainRows = await parseFile(STATE.fileMain);
  STATE.datasetLabel = findGroupLabel(mainRows);
  const mainSeries = extractSeries(mainRows);

  // Urban water uses its own self-contained semester engine (no annualise /
  // template / population step). River flow stays in cms with a seasonal shape.
  if (STATE.category === "water") {
    const results = mainSeries.map(s => processWaterSeries(s));
    return { results, template: null };
  }

  for (const s of mainSeries) {
    s.annual = annualizeRiverFlow(s.records);
    s.seasonalShape = computeSeasonalShape(s.annual);
    s.baseMonthlyMedian = computeMonthlyMedian(s.annual);
    const obsAnnual = Object.keys(s.annual).map(Number).sort((a, b) => a - b)
      .map(y => s.annual[y].annual).filter(v => v != null);
    s.mk = mannKendall(obsAnnual);
  }

  // Choose template (longest record) for the river gap-fill fallback.
  const template = selectTemplate(mainSeries);
  const templateAnnual = template
    ? mainSeries.find(s => s.name === template.name).annual
    : null;

  const results = mainSeries.map(s => processSeries(s, template, templateAnnual, null, {
    popMode: "without",
    timeframe: STATE.timeframe,
    category: STATE.category
  }));
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
  if (category === "water") {
    insights.push(`Urban water extraction (m³). Each station is modelled <strong>per semester</strong> — S1 (Jan–Jun, dry) and S2 (Jul–Dec, wet) independently — then broadcast back to the six months of that semester. Historical gaps are filled geometrically (CAGR); the 2025–2050 projection uses the model the data supports, and every value is floored at 0.`);
    if (r.waterModelS1 || r.waterModelS2) {
      insights.push(`Projection model — <strong>S1:</strong> ${waterModelLabel(r.waterModelS1)}; <strong>S2:</strong> ${waterModelLabel(r.waterModelS2)}.`);
    }
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
    parts.push(`<strong>${r.name}</strong> — pre-record years back-cast from the ` +
               `<strong>${r.template}</strong> template via <code>value(${r.name}) ÷ value(${r.template})</code>, ` +
               `median R̂ = <strong>${r.Rmedian.toFixed(3)}</strong>, ` +
               `from <strong>${r.overlap}</strong> overlap year${r.overlap === 1 ? "" : "s"} ` +
               `(CV = ${(r.cv * 100).toFixed(1)}%). Tier: ${flagLabel(r.tier)}.`);
  }
  if (STATE.category === "water" && (STATE.timeframe === "projected" || STATE.timeframe === "both")) {
    parts.push(`Projection — <strong>S1:</strong> ${waterModelLabel(r.waterModelS1)}; <strong>S2:</strong> ${waterModelLabel(r.waterModelS2)}. Model chosen per semester from the data (quadratic / log-linear / CAGR / linear OLS); floored at 0.`);
  } else if (STATE.category === "riverflow" && (STATE.timeframe === "projected" || STATE.timeframe === "both")) {
    parts.push(`Projection: Climate Delta Scaling (PAGASA 2018, RCP4.5) on the observed monthly-median baseline; ±${(RIVER_ENVELOPE*100).toFixed(0)}% planning band; physical floor ${RIVER_MIN_FLOW} cms.`);
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
  const showPop = false;
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
        } else if (row.monthly_vals && row.monthly_vals[m] != null) {
          // Urban water: the per-month value is the semester value (S1 for
          // months 1–6, S2 for 7–12).
          v = row.monthly_vals[m];
          lo = row.value_lower90 != null && row.value_mean
            ? row.value_lower90 * (v / row.value_mean) : null;
          hi = row.value_upper90 != null && row.value_mean
            ? row.value_upper90 * (v / row.value_mean) : null;
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
  // Urban water: per-month value is the semester value (S1 for months 1–6,
  // S2 for 7–12), carried on the row's monthly_vals.
  if (row.monthly_vals && row.monthly_vals[monthIdx] != null) return row.monthly_vals[monthIdx];
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
  const unit = STATE.category === "riverflow" ? "cms" : "m3";
  // River flow is small (decimals matter); urban water is whole m³.
  const dec = STATE.category === "riverflow" ? 2 : 0;
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
        return v == null ? "" : v.toFixed(dec);
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
  const category = STATE.category === "riverflow" ? "River Flow / Streamflow (cms)"
                 : "Urban Water Use (m³)";
  const timeframe = STATE.timeframe === "projected" ? "Projected Data (2025–2050)"
                  : STATE.timeframe === "both"      ? "Both — Historical + Projected (2000–2050)"
                  : "Current Data (2000–2024)";
  const granularity = STATE.granularity === "monthly" ? "Monthly" : "Annual";

  let body = `
    <h1>Fluxo Analysis Report</h1>
    <p><em>College of Climate Change and Environmental Management · Central Luzon State University</em></p>
    <hr/>
    <p><strong>File:</strong> ${originalFilename}</p>
    <p><strong>Generated:</strong> ${ts}</p>
    <p><strong>Category:</strong> ${category}</p>
    <p><strong>Timeframe:</strong> ${timeframe}</p>
    <p><strong>Granularity:</strong> ${granularity}</p>
    <p><strong>Method:</strong> ${STATE.category === "riverflow"
      ? "River flow stays in cms (no conversion, no totals — only the rate is predicted). Pre-record years back-cast from the longest gauge in the upload; forward projection by Climate Delta Scaling (PAGASA 2018 Region III RCP4.5) on the observed monthly-median baseline, ramped linearly 2010→2050, floored at " + RIVER_MIN_FLOW + " cms; ±" + (RIVER_ENVELOPE*100).toFixed(0) + "% planning band. Mann-Kendall reported per series."
      : "Per-station, per-semester (S1 Jan–Jun, S2 Jul–Dec). Historical gaps filled geometrically (CAGR back-cast / local-CAGR interior, physical floor); 2025–2050 projected by a data-selected model (quadratic / log-linear / CAGR-exact / linear OLS); all values floored at 0."}</p>
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
    const rfmt = STATE.category === "riverflow" ? fmt2 : fmtInt;
    const vUnit = STATE.category === "riverflow" ? "Mean cms" : "Annual m³";
    body += `<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:13px;">
      <thead><tr><th>Year</th><th>${vUnit}</th><th>90% CI</th><th>Status</th></tr></thead><tbody>`;
    const years = Object.keys(r.rows).map(Number).sort((a, b) => a - b);
    for (const y of years) {
      const row = r.rows[y];
      body += `<tr>
        <td>${y}</td>
        <td>${rfmt(row.value_mean)}</td>
        <td>${rfmt(row.value_lower90)} – ${rfmt(row.value_upper90)}</td>
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
  return false;   // step 4 is the upload/run panel — gated by the Run button
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
  $("#runBtn").disabled = !STATE.fileMain;
}

// Upload-step copy adapts to the chosen category.
function applyUploadCopy() {
  const isRiver = STATE.category === "riverflow";
  $("#mainLabel").textContent = isRiver ? "River flow dataset (cms)" : "Urban water dataset (m³)";
  const helpBits = [
    "Provide a wide-format CSV/XLSX (Year, Month, Loc1, Loc2, …). Empty cells are treated as missing values."
  ];
  helpBits.push(isRiver
    ? "Discharge stays in cms (m³/s) — only the missing flow rate is predicted; observed months pass through unchanged."
    : "Each station is modelled per semester (S1 Jan–Jun, S2 Jul–Dec): gaps filled geometrically, then projected by a data-selected model.");
  if (STATE.timeframe === "projected" || STATE.timeframe === "both") {
    helpBits.push(isRiver
      ? "Output horizon extends to 2050 via Climate Delta Scaling (PAGASA 2018 RCP4.5)."
      : "Output horizon extends to 2050 (quadratic / log-linear / CAGR / linear OLS per semester).");
  }
  $("#uploadHelp").innerHTML = helpBits.join(" ");
}

function selectOpt(el) {
  const key = el.dataset.key;
  const value = el.dataset.value;
  STATE[key] = value;
  // Mark sibling options.
  el.parentElement.querySelectorAll(".opt").forEach(o => o.classList.toggle("selected", o === el));
  if (key === "category") applyUploadCopy();
  if (key === "timeframe") {
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
      if (cur + 1 === 4) applyUploadCopy();
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
  STATE.category = STATE.timeframe = STATE.granularity = null;
  STATE.fileMain = null;
  STATE.datasetLabel = "";
  STATE.results = null;
  $$(".opt").forEach(o => o.classList.remove("selected"));
  $("#mainPill").innerHTML = "";
  $("#fileMain").value = "";
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
  applyUploadCopy();

  bindDropzone($("#dropzoneMain"), $("#fileMain"), $("#mainPill"), (f) => {
    STATE.fileMain = f;
    setPill($("#mainPill"), f, true);
    refreshRunButton();
  });

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
