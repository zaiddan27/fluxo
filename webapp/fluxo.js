//===========================================================================
// EMBEDDED REFERENCE DATA (computed from datasets_processed_bulacan/)
//===========================================================================
const DRT_LPCD = {2000:35.18,2001:46.65,2002:44.95,2003:43.39,2004:41.94,2005:40.6,2006:39.36,2007:38.21,2008:37.13,2009:36.2,2010:39.17,2011:48.73,2012:58.3,2013:67.86,2014:77.42,2015:86.99,2016:89.74,2017:92.49,2018:95.24,2019:97.99,2020:100.73,2021:104.23,2022:107.72,2023:111.21,2024:114.7};

const POP_CENSUS = {
  "Dona Remedios Trinidad": {1990:8614,2000:13636,2010:19878,2015:22663,2020:28656,2024:30064},
  "DRT": {1990:8614,2000:13636,2010:19878,2015:22663,2020:28656,2024:30064},
  "Norzagaray": {1990:33485,2000:76978,2010:103095,2015:111348,2020:136064,2024:140697},
  "Angat": {1990:34494,2000:46033,2010:55332,2015:59237,2020:65617,2024:67862},
  "Bulacan": {1990:48770,2000:62903,2010:71751,2015:76565,2020:81232,2024:83101},
  "Bustos": {1990:34965,2000:47091,2010:62415,2015:67039,2020:77199,2024:80565},
  "Plaridel": {1990:52954,2000:80481,2010:101441,2015:107805,2020:114432,2024:120939},
  "San Rafael": {1990:49528,2000:69770,2010:85921,2015:94655,2020:103097,2024:108256},
  "City of Malolos": {1990:125178,2000:175291,2010:234945,2015:252074,2020:261189,2024:269809},
  "Hagonoy": {1990:90212,2000:111425,2010:125689,2015:129807,2020:133448,2024:136673},
  "Baliwag": {1990:89719,2000:119675,2010:143565,2015:149954,2020:168470,2024:174194},
  "Calumpit": {1990:59042,2000:81113,2010:101068,2015:108757,2020:118471,2024:122187},
  "Guiguinto": {1990:44532,2000:67571,2010:90507,2015:99730,2020:113415,2024:118173},
  "Pandi": {1990:32648,2000:48088,2010:66650,2015:89075,2020:155115,2024:162725},
  "Balagtas": {1990:42658,2000:56945,2010:65440,2015:73929,2020:77018,2024:80221},
  "Bocaue": {1990:67243,2000:86994,2010:106407,2015:119675,2020:141412,2024:147755},
  "Marilao": {1990:56361,2000:101017,2010:185624,2015:221965,2020:254453,2024:263507},
  "Meycauayan City": {1990:123982,2000:163037,2010:199154,2015:209083,2020:225673,2024:228023},
  "Obando": {1990:46346,2000:52906,2010:58009,2015:59197,2020:59978,2024:61073},
  "San Jose del Monte City": {1990:142047,2000:315807,2010:454553,2015:574089,2020:651813,2024:685688},
  "Santa Maria": {1990:91468,2000:144282,2010:218351,2015:256454,2020:289820,2024:322525},
  "San Ildefonso": {1990:59598,2000:79956,2010:95000,2015:104471,2020:115713,2024:123140},
  "San Miguel": {1990:91124,2000:123824,2010:142854,2015:153882,2020:172073,2024:179792}
};

// Per-confidence-tier empirical (true-pred)/pred quantiles from validation
const TIERS = {
  backcast_high: {q05: -0.2109, q95: 0.3367},
  backcast_mid:  {q05: -0.1344, q95: 1.2120},
  backcast_low:  {q05:  0.1509, q95: 2.1471}
};

const MUNI_ALIASES = {
  "drt": "Dona Remedios Trinidad",
  "dona remedios trinidad": "Dona Remedios Trinidad",
  "doña remedios trinidad": "Dona Remedios Trinidad",
  "bulakan": "Bulacan",
  "city of meycauayan": "Meycauayan City",
  "meycauayan": "Meycauayan City",
  "san jose del monte": "San Jose del Monte City",
  "city of malolos": "City of Malolos",
  "malolos": "City of Malolos",
  "santa maria": "Santa Maria",
  "sta maria": "Santa Maria",
  "sta. maria": "Santa Maria"
};

const REPORT_REFERENCES = [
  "Hirsch, R.M. (1982). A comparison of four streamflow record extension techniques. Water Resources Research 18(4): 1081–1088.",
  "WMO (1994). Technical Note No. 175 — Hydrological Network Design.",
  "Vogel, R.M., Stedinger, J.R. (1985). Minimum variance streamflow record augmentation procedures. WRR 21(5): 715–723.",
  "Gneiting, T., Raftery, A.E. (2007). Strictly proper scoring rules, prediction, and estimation. JASA 102(477): 359–378.",
  "van Buuren, S. (2018). Flexible Imputation of Missing Data, 2nd ed. CRC Press.",
  "PSA Census of Population and Housing, 1990–2020.",
  "PIDS (1999). Determination of Basic Household Water Requirements. Discussion Paper 99-02.",
  "ADB (2013). Philippines: Water Supply and Sanitation Sector Assessment."
];

//===========================================================================
// HELPERS
//===========================================================================
function normalizeMuniName(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^[\s;,]+|[\s;,]+$/g, "");
  // Direct match (case-insensitive)
  for (const muni of Object.keys(POP_CENSUS)) {
    if (s.toLowerCase() === muni.toLowerCase()) return muni;
  }
  const lower = s.toLowerCase();
  if (MUNI_ALIASES[lower]) return MUNI_ALIASES[lower];
  return null; // unknown muni → cannot backcast
}

function interpolatePopulation(muni, year) {
  const pop = POP_CENSUS[muni];
  if (!pop) return null;
  const years = Object.keys(pop).map(Number).sort((a,b) => a-b);
  if (year <= years[0]) return pop[years[0]];
  if (year >= years[years.length-1]) return pop[years[years.length-1]];
  for (let i = 0; i < years.length-1; i++) {
    if (year >= years[i] && year <= years[i+1]) {
      const y0 = years[i], y1 = years[i+1];
      const p0 = pop[y0], p1 = pop[y1];
      return p0 + (p1 - p0) * (year - y0) / (y1 - y0);
    }
  }
  return null;
}

function median(arr) {
  const sorted = [...arr].sort((a,b) => a-b);
  const n = sorted.length;
  if (!n) return NaN;
  return n % 2 ? sorted[(n-1)/2] : (sorted[n/2 - 1] + sorted[n/2]) / 2;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a,b) => a+b, 0) / arr.length;
  const v = arr.reduce((a,b) => a + (b-m)*(b-m), 0) / arr.length;
  return Math.sqrt(v);
}

function classifyTier(nOverlap, cvR) {
  if (nOverlap >= 5 && cvR <= 0.20) return "backcast_high";
  if (nOverlap >= 3 && cvR <= 0.35) return "backcast_mid";
  return "backcast_low";
}

function fmtInt(x) {
  if (x == null || isNaN(x)) return "—";
  return Math.round(x).toLocaleString();
}

function fmt1(x) {
  if (x == null || isNaN(x)) return "—";
  return x.toFixed(1);
}

//===========================================================================
// FILE PARSING
//===========================================================================
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
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, {type: "array"});
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, {header: 1, defval: null});
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function rowsToMatrix(rows) {
  return rows.map(r => Array.isArray(r) ? r : Object.values(r));
}

//===========================================================================
// EXTRACT MUNI SERIES FROM PARSED ROWS
//===========================================================================
function extractSeries(rows) {
  // Find the header row: the first row that contains "Year" or "year"
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
  if (headerIdx < 0) throw new Error("Could not find a header row containing 'Year'. Make sure your file has a 'Year' column.");

  const header = rows[headerIdx].map(c => c == null ? "" : String(c).replace(/^[;\s]+|[\s]+$/g, ""));
  const yearCol = header.findIndex(c => c.toLowerCase().includes("year"));
  const monthCol = header.findIndex(c => c.toLowerCase().includes("month"));
  if (yearCol < 0) throw new Error("No 'Year' column found.");

  // Each remaining column is a muni
  const muniCols = [];
  for (let i = 0; i < header.length; i++) {
    if (i === yearCol || i === monthCol) continue;
    if (!header[i] || header[i].trim() === "") continue;
    const normalized = normalizeMuniName(header[i]);
    muniCols.push({ raw: header[i], normalized, colIdx: i });
  }

  // Data rows
  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const y = parseFloat(r[yearCol]);
    if (isNaN(y) || y < 1900 || y > 2100) continue;
    const m = monthCol >= 0 ? parseFloat(r[monthCol]) : 1;
    for (const mc of muniCols) {
      const v = r[mc.colIdx];
      const num = (v === "" || v == null) ? null : parseFloat(v);
      records.push({
        year: Math.round(y),
        month: monthCol >= 0 && !isNaN(m) ? Math.round(m) : 1,
        muniColRaw: mc.raw,
        muniNormalized: mc.normalized,
        value: (num == null || isNaN(num)) ? null : num
      });
    }
  }

  // Group by muni
  const byMuni = {};
  for (const rec of records) {
    if (!byMuni[rec.muniColRaw]) {
      byMuni[rec.muniColRaw] = { raw: rec.muniColRaw, normalized: rec.muniNormalized, records: [] };
    }
    byMuni[rec.muniColRaw].records.push(rec);
  }
  return Object.values(byMuni);
}

//===========================================================================
// ANNUALIZE → BACKCAST → CALIBRATE
//===========================================================================
function annualize(records) {
  // For each year, mean of the (potentially identical) monthly values
  const byYear = {};
  for (const rec of records) {
    if (!byYear[rec.year]) byYear[rec.year] = [];
    if (rec.value != null) byYear[rec.year].push(rec.value);
  }
  const annual = {};
  for (const y of Object.keys(byYear)) {
    const vals = byYear[y];
    if (vals.length > 0) {
      const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
      annual[+y] = { monthly_mean: mean, annual_m3: mean * 12 };
    } else {
      annual[+y] = { monthly_mean: null, annual_m3: null };
    }
  }
  return annual;
}

function backcastMuni(muniNormalized, annual) {
  if (!muniNormalized) {
    return { supported: false, reason: "Municipality name not in reference database (22 Bulacan munis supported)." };
  }

  // Build observed LPCD per year using interpolated population
  const observedLpcd = {};
  for (const y of Object.keys(annual)) {
    const a = annual[+y].annual_m3;
    if (a == null) continue;
    const pop = interpolatePopulation(muniNormalized, +y);
    if (pop == null) continue;
    observedLpcd[+y] = (a * 1000) / (pop * 365);
  }
  const observedYears = Object.keys(observedLpcd).map(Number);
  if (observedYears.length === 0) {
    return { supported: false, reason: "No observed data found in your upload for this column." };
  }
  const firstObsYear = Math.min(...observedYears);

  // DRT is the template — no backcasting needed
  if (muniNormalized === "Dona Remedios Trinidad") {
    const rows = {};
    for (let y = 2000; y <= 2024; y++) {
      const a = annual[y]?.annual_m3 ?? null;
      const pop = interpolatePopulation(muniNormalized, y);
      const lpcd = a != null && pop != null ? (a * 1000)/(pop*365) : null;
      rows[y] = {
        year: y,
        population: pop,
        lpcd_mean: lpcd, lpcd_lower90: lpcd, lpcd_upper90: lpcd,
        annual_m3_mean: a, annual_m3_lower90: a, annual_m3_upper90: a,
        monthly_m3_mean: a == null ? null : a/12,
        flag: a == null ? "missing" : "observed",
        n_overlap_years: null, cv_ratio: null
      };
    }
    return { supported: true, muni: muniNormalized, rows };
  }

  // Compute ratios on overlap years (years where both target and DRT observed)
  const overlap = observedYears.filter(y => DRT_LPCD[y] != null);
  const ratios = overlap.map(y => observedLpcd[y] / DRT_LPCD[y]).filter(r => isFinite(r) && r > 0);
  if (ratios.length === 0) {
    return { supported: false, reason: "No overlap years between this series and the DRT template." };
  }
  const Rmed = median(ratios);
  const Rmean = ratios.reduce((a,b)=>a+b,0)/ratios.length;
  const Rcv = Rmean > 0 ? stdev(ratios)/Rmean : Infinity;
  const tier = classifyTier(ratios.length, Rcv);
  const tierQ = TIERS[tier];

  // Now build output rows 2000..2024
  const rows = {};
  for (let y = 2000; y <= 2024; y++) {
    const a = annual[y]?.annual_m3 ?? null;
    const pop = interpolatePopulation(muniNormalized, y);
    if (a != null && pop != null) {
      const lpcd = (a*1000)/(pop*365);
      rows[y] = {
        year: y, population: pop,
        lpcd_mean: lpcd, lpcd_lower90: lpcd, lpcd_upper90: lpcd,
        annual_m3_mean: a, annual_m3_lower90: a, annual_m3_upper90: a,
        monthly_m3_mean: a/12,
        flag: "observed",
        n_overlap_years: ratios.length, cv_ratio: Rcv
      };
    } else if (DRT_LPCD[y] != null && pop != null) {
      const lpcd_mean = Rmed * DRT_LPCD[y];
      const annual_mean = lpcd_mean * pop * 365 / 1000;
      const annual_lo = annual_mean * (1 + tierQ.q05);
      const annual_hi = annual_mean * (1 + tierQ.q95);
      rows[y] = {
        year: y, population: pop,
        lpcd_mean: lpcd_mean,
        lpcd_lower90: lpcd_mean * (1 + tierQ.q05),
        lpcd_upper90: lpcd_mean * (1 + tierQ.q95),
        annual_m3_mean: annual_mean,
        annual_m3_lower90: annual_lo,
        annual_m3_upper90: annual_hi,
        monthly_m3_mean: annual_mean / 12,
        flag: tier,
        n_overlap_years: ratios.length,
        cv_ratio: Rcv
      };
    } else {
      rows[y] = {
        year: y, population: pop,
        lpcd_mean: null, lpcd_lower90: null, lpcd_upper90: null,
        annual_m3_mean: null, annual_m3_lower90: null, annual_m3_upper90: null,
        monthly_m3_mean: null,
        flag: "missing", n_overlap_years: ratios.length, cv_ratio: Rcv
      };
    }
  }
  return {
    supported: true, muni: muniNormalized,
    overlap: ratios.length, cv: Rcv, Rmedian: Rmed, tier,
    rows
  };
}

//===========================================================================
// RENDERERS
//===========================================================================
function renderSummary(results) {
  const grid = document.getElementById("summaryGrid");
  const munis = results.length;
  const supported = results.filter(r => r.supported).length;
  let totalBackcastCells = 0, totalObservedCells = 0;
  for (const r of results) {
    if (!r.supported || !r.rows) continue;
    for (const y of Object.keys(r.rows)) {
      const f = r.rows[+y].flag;
      if (f === "observed") totalObservedCells++;
      else if (f.startsWith("backcast")) totalBackcastCells++;
    }
  }
  grid.innerHTML = `
    <div class="summary-card"><div class="label">Series detected</div><div class="value">${munis}</div><div class="sub">${supported} supported</div></div>
    <div class="summary-card"><div class="label">Cells preserved (observed)</div><div class="value">${totalObservedCells}</div></div>
    <div class="summary-card"><div class="label">Cells gap-filled</div><div class="value">${totalBackcastCells}</div></div>
    <div class="summary-card"><div class="label">Coverage</div><div class="value">2000–2024</div><div class="sub">annual + monthly</div></div>
  `;
}

function flagLabel(f) {
  if (f === "observed") return '<span class="flag flag-observed">observed</span>';
  if (f === "backcast_high") return '<span class="flag flag-backcast_high">high confidence</span>';
  if (f === "backcast_mid")  return '<span class="flag flag-backcast_mid">mid confidence</span>';
  if (f === "backcast_low")  return '<span class="flag flag-backcast_low">low confidence</span>';
  if (f === "missing")       return '<span class="flag flag-unsupported">missing</span>';
  return '<span class="flag flag-unsupported">' + f + '</span>';
}

function explainResult(r) {
  if (!r.supported) return `<div class="alert alert-warn"><strong>Could not process:</strong> ${r.reason}</div>`;
  if (r.muni === "Dona Remedios Trinidad")
    return `<div class="explanation">This is the <strong>template municipality</strong> — all 25 years are observed.
            No backcasting is applied; the values pass through with no modification beyond annualization.</div>`;
  return `<div class="explanation">
    <strong>${r.muni}</strong> — backcasting tier: ${flagLabel(r.tier)}.
    Method: median ratio of <code>LPCD<sub>${r.muni.split(' ')[0]}</sub> / LPCD<sub>DRT</sub></code>
    computed from <strong>${r.overlap}</strong> overlap years
    (CV = ${(r.cv*100).toFixed(1)}%, R̂ = ${r.Rmedian.toFixed(3)}).
    Backcast formula: <code>LPCD(y) = ${r.Rmedian.toFixed(3)} × LPCD<sub>DRT</sub>(y)</code>;
    demand = LPCD × population × 365 ÷ 1000.
    90% CI from empirical hold-out validation for ${r.tier.replace("backcast_","")}-tier munis
    (multiplier [${(1+TIERS[r.tier].q05).toFixed(2)}, ${(1+TIERS[r.tier].q95).toFixed(2)}]).
  </div>`;
}

function renderMuniBlock(r) {
  const block = document.createElement("div");
  block.className = "muni-block";
  if (!r.supported) {
    block.innerHTML = `
      <div class="muni-block-header">
        <h3>${r.muni || "Unknown column"}</h3>
        <span class="meta">unsupported</span>
      </div>
      <div class="muni-block-body">${explainResult(r)}</div>`;
    return block;
  }
  const years = Object.keys(r.rows).map(Number).sort((a,b)=>a-b);
  const rowsHtml = years.map(y => {
    const row = r.rows[y];
    const cls = row.flag.startsWith("backcast") ? "row-backcast" : "";
    return `<tr class="${cls}">
      <td>${y}</td>
      <td>${flagLabel(row.flag)}</td>
      <td>${fmtInt(row.population)}</td>
      <td>${fmt1(row.lpcd_mean)}</td>
      <td>${fmt1(row.lpcd_lower90)} – ${fmt1(row.lpcd_upper90)}</td>
      <td>${fmtInt(row.annual_m3_mean)}</td>
      <td>${fmtInt(row.annual_m3_lower90)} – ${fmtInt(row.annual_m3_upper90)}</td>
      <td>${fmtInt(row.monthly_m3_mean)}</td>
    </tr>`;
  }).join("");
  block.innerHTML = `
    <div class="muni-block-header">
      <h3>${r.muni}</h3>
      <span class="meta">${r.tier ? r.tier.replace("backcast_","") + " tier · " + r.overlap + " overlap yrs" : "template series"}</span>
    </div>
    <div class="muni-block-body">
      ${explainResult(r)}
      <div class="table-wrapper"><table>
        <thead><tr>
          <th>Year</th><th>Status</th><th>Population</th><th>LPCD</th><th>LPCD 90% CI</th>
          <th>Annual m³</th><th>Annual m³ 90% CI</th><th>Monthly m³ (avg)</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
    </div>`;
  return block;
}

//===========================================================================
// EXPORTS
//===========================================================================
function buildFilledCsv(results) {
  const header = [
    "year","municipality","tier","population",
    "lpcd_mean","lpcd_lower90","lpcd_upper90",
    "annual_m3_mean","annual_m3_lower90","annual_m3_upper90",
    "monthly_m3_mean"
  ];
  const lines = [header.join(",")];
  for (const r of results) {
    if (!r.supported || !r.rows) continue;
    const years = Object.keys(r.rows).map(Number).sort((a,b)=>a-b);
    for (const y of years) {
      const row = r.rows[y];
      lines.push([
        y, JSON.stringify(r.muni), row.flag,
        row.population == null ? "" : Math.round(row.population),
        row.lpcd_mean == null ? "" : row.lpcd_mean.toFixed(2),
        row.lpcd_lower90 == null ? "" : row.lpcd_lower90.toFixed(2),
        row.lpcd_upper90 == null ? "" : row.lpcd_upper90.toFixed(2),
        row.annual_m3_mean == null ? "" : Math.round(row.annual_m3_mean),
        row.annual_m3_lower90 == null ? "" : Math.round(row.annual_m3_lower90),
        row.annual_m3_upper90 == null ? "" : Math.round(row.annual_m3_upper90),
        row.monthly_m3_mean == null ? "" : Math.round(row.monthly_m3_mean)
      ].join(","));
    }
  }
  return lines.join("\n");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function copyTableToClipboard(results) {
  // Tab-separated for paste into Excel
  const lines = ["Year\tMunicipality\tTier\tPopulation\tLPCD\tLPCD low\tLPCD high\tAnnual m3\tAnnual low\tAnnual high\tMonthly m3"];
  for (const r of results) {
    if (!r.supported || !r.rows) continue;
    const years = Object.keys(r.rows).map(Number).sort((a,b)=>a-b);
    for (const y of years) {
      const row = r.rows[y];
      lines.push([
        y, r.muni, row.flag,
        row.population == null ? "" : Math.round(row.population),
        row.lpcd_mean == null ? "" : row.lpcd_mean.toFixed(1),
        row.lpcd_lower90 == null ? "" : row.lpcd_lower90.toFixed(1),
        row.lpcd_upper90 == null ? "" : row.lpcd_upper90.toFixed(1),
        row.annual_m3_mean == null ? "" : Math.round(row.annual_m3_mean),
        row.annual_m3_lower90 == null ? "" : Math.round(row.annual_m3_lower90),
        row.annual_m3_upper90 == null ? "" : Math.round(row.annual_m3_upper90),
        row.monthly_m3_mean == null ? "" : Math.round(row.monthly_m3_mean)
      ].join("\t"));
    }
  }
  const text = lines.join("\n");
  navigator.clipboard.writeText(text).then(() => {
    alert("Copied " + (lines.length-1) + " rows to clipboard. Paste into Excel or Google Sheets.");
  }).catch(err => alert("Copy failed: " + err.message));
}

function buildHtmlReport(results, originalFilename) {
  const ts = new Date().toLocaleString();
  let body = `<h1>Fluxo Imputation Report</h1>
  <p><strong>File:</strong> ${originalFilename}</p>
  <p><strong>Generated:</strong> ${ts}</p>
  <p><strong>Method:</strong> Station-substitution (MOVE / Hirsch 1982) using Doña Remedios Trinidad
  as long-record template, per-tier empirically calibrated 90% CI.</p>`;
  for (const r of results) {
    if (!r.supported) {
      body += `<h2>${r.muni || "Unknown"}</h2><p style="color:red;">${r.reason}</p>`;
      continue;
    }
    body += `<h2>${r.muni}</h2>`;
    if (r.muni !== "Dona Remedios Trinidad") {
      body += `<p>Tier: <strong>${r.tier}</strong>; overlap years: <strong>${r.overlap}</strong>;
        CV(R)=${(r.cv*100).toFixed(1)}%; R̂=${r.Rmedian.toFixed(3)}.</p>`;
    }
    body += `<table border="1" cellpadding="4" style="border-collapse:collapse;">
      <thead><tr><th>Year</th><th>Status</th><th>Population</th><th>LPCD</th>
      <th>LPCD CI</th><th>Annual m³</th><th>Annual CI</th><th>Monthly m³</th></tr></thead><tbody>`;
    const years = Object.keys(r.rows).map(Number).sort((a,b)=>a-b);
    for (const y of years) {
      const row = r.rows[y];
      body += `<tr><td>${y}</td><td>${row.flag}</td>
        <td>${fmtInt(row.population)}</td>
        <td>${fmt1(row.lpcd_mean)}</td>
        <td>${fmt1(row.lpcd_lower90)} – ${fmt1(row.lpcd_upper90)}</td>
        <td>${fmtInt(row.annual_m3_mean)}</td>
        <td>${fmtInt(row.annual_m3_lower90)} – ${fmtInt(row.annual_m3_upper90)}</td>
        <td>${fmtInt(row.monthly_m3_mean)}</td></tr>`;
    }
    body += `</tbody></table>`;
  }
  body += `<h2>References</h2><ol>` +
    REPORT_REFERENCES.map(r => `<li>${r}</li>`).join("") + `</ol>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fluxo Report</title>
    <style>body{font-family:sans-serif;max-width:1100px;margin:24px auto;padding:0 12px;color:#222;}
    h1{color:#0F4F1F;} h2{color:#1B5E20;border-bottom:1px solid #ccc;padding-bottom:4px;}
    table{font-size:13px;}</style></head><body>${body}</body></html>`;
}

//===========================================================================
// MAIN: WIRE UP UI
//===========================================================================
let currentResults = null;
let currentFilename = null;

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadInfo = document.getElementById("uploadInfo");
const processingSection = document.getElementById("processingSection");
const resultsSection = document.getElementById("resultsSection");
const resultsContainer = document.getElementById("resultsContainer");

dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault(); dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", e => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  currentFilename = file.name;
  uploadInfo.innerHTML = `<div class="alert alert-info">📄 Loaded <strong>${file.name}</strong> (${(file.size/1024).toFixed(1)} KB). Processing…</div>`;
  processingSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");

  try {
    const rows = await parseFile(file);
    const series = extractSeries(rows);
    const results = [];
    for (const s of series) {
      const annual = annualize(s.records);
      const out = backcastMuni(s.normalized, annual);
      results.push({...out, muni: out.muni || s.raw});
    }
    currentResults = results;
    renderResults(results);
  } catch (err) {
    processingSection.classList.add("hidden");
    uploadInfo.innerHTML = `<div class="alert alert-err">⚠ ${err.message}</div>`;
    console.error(err);
  }
}

function renderResults(results) {
  processingSection.classList.add("hidden");
  resultsSection.classList.remove("hidden");
  renderSummary(results);
  resultsContainer.innerHTML = "";
  for (const r of results) resultsContainer.appendChild(renderMuniBlock(r));
  uploadInfo.innerHTML = `<div class="alert alert-info">✓ Processed <strong>${results.length}</strong> series from <strong>${currentFilename}</strong>.</div>`;
}

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!currentResults) return;
  downloadBlob(buildFilledCsv(currentResults), (currentFilename || "fluxo") + "_filled.csv", "text/csv");
});
document.getElementById("copyBtn").addEventListener("click", () => {
  if (!currentResults) return;
  copyTableToClipboard(currentResults);
});
document.getElementById("downloadReportBtn").addEventListener("click", () => {
  if (!currentResults) return;
  downloadBlob(buildHtmlReport(currentResults, currentFilename), (currentFilename || "fluxo") + "_report.html", "text/html");
});
