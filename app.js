// Return Map - static (no framework). Tudo roda no browser.

const DATASETS = {
  br: {
    label: "Brasil",
    folder: "data/br",
    riskFreeQuantumName: "CDI",
    currency: "BRL",
  },
  ex: {
    label: "Exterior",
    folder: "data/ex",
    riskFreeQuantumName: "SOFR",
    currency: "USD",
  },
};

// UI state
let state = {
  geography: "br",
  displayMode: "stacked", // stacked | zero | asset
  highlightMode: "class", // class | return
  referenceAssetId: null,
  hoveredAssetId: null,
};

const ui = {
  subtitle: document.getElementById("subtitle"),
  chart: document.getElementById("chart"),
  legendRow: document.getElementById("legendRow"),
  tooltip: document.getElementById("tooltip"),
  refAssetGroup: document.getElementById("refAssetGroup"),
  refAssetSelect: document.getElementById("refAssetSelect"),
};

const btn = {
  geoBr: document.getElementById("geo-br"),
  geoEx: document.getElementById("geo-ex"),
  modeStacked: document.getElementById("mode-stacked"),
  modeZero: document.getElementById("mode-zero"),
  modeAsset: document.getElementById("mode-asset"),
  hlClass: document.getElementById("hl-class"),
  hlReturn: document.getElementById("hl-return"),
};

function setActive(el, active){
  el.classList.toggle("is-active", !!active);
}

// Basic utilities
function normalize(str){
  return String(str ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

function parseNumberPtBR(value){
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  // Quantum costuma vir em decimal com vírgula (ex: 0,1234)
  const normalized = s.replace(/\./g, "").replace(/,/g, ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(v, digits=1){
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  // v está em decimal (0.12 => 12%)
  return new Intl.NumberFormat("pt-BR", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

function fmtNum(v, digits=2){
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

// Simple semicolon CSV parser (handles quotes)
function parseCSV(text, delimiter=";"){
  const rows = [];
  let cur = "";
  let inQuotes = false;
  let row = [];
  for (let i=0;i<text.length;i++){
    const ch = text[i];
    const next = text[i+1];
    if (ch === '"'){
      if (inQuotes && next === '"'){
        cur += '"'; i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter){
      row.push(cur);
      cur = "";
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")){
      if (ch === "\r" && next === "\n"){ i++; }
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length){
    row.push(cur);
    rows.push(row);
  }

  // Remove trailing empty rows
  while (rows.length && rows[rows.length-1].every(c => String(c).trim() === "")){
    rows.pop();
  }

  const header = rows[0] ?? [];
  const data = [];
  for (let r=1;r<rows.length;r++){
    const obj = {};
    for (let c=0;c<header.length;c++){
      obj[header[c]] = rows[r][c] ?? "";
    }
    data.push(obj);
  }
  return { header, data };
}

async function fetchText(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Falha ao carregar: ${url} (${res.status})`);
  return await res.text();
}

// Identify columns from Quantum CSV
function extractColumns(quantumHeader){
  const returnCols = [];
  let annualisedCol = null;
  let volCol = null;
  let maxDDCol = null;

  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")   // remove acentos
      .replace(/\uFFFD/g, "");          // remove o "�" (replacement char)

  for (const h of quantumHeader){
    const hs = String(h).trim();
    const hn = norm(hs);

    // Retorno (anos / períodos)
    // Aceita: "Retorno - diaria (...)" e também o caso quebrado "di�ria"
    if (/^retorno\s*-\s*di.?ria\s*\(/.test(hn)){
      // (2016)
      const mYear = hs.match(/\((\d{4})\)/);
      if (mYear){
        returnCols.push({ id: mYear[1], label: mYear[1], source: hs, kind: "return" });
        continue;
      }

      // (02/06/2015 até 31/12/2015) — aqui não depende da palavra "até"
      const mRange = hs.match(/\((\d{2}\/\d{2}\/\d{4}).*?(\d{2}\/\d{2}\/\d{4})\)/);
      if (mRange){
        const start = mRange[1];
        const end = mRange[2];
        const endYear = end.slice(-4);
        const star = start.startsWith("01/01") ? "" : "*";
        returnCols.push({ id: `${endYear}${star}`, label: `${endYear}${star}`, source: hs, kind: "return" });
        continue;
      }
      continue;
    }

    // Anualizado / Vol / Max DD (mesma lógica, sem depender do acento)
    if (!annualisedCol && hn.startsWith("anualizado")) annualisedCol = hs;
    if (!volCol && hn.startsWith("volatilidade")) volCol = hs;
    if (!maxDDCol && (hn.includes("drawdown") || hn.includes("maximo drawdown") || hn.includes("maximo") && hn.includes("drawdown"))) {
      maxDDCol = hs;
    }
  }

  // Sort returnCols by year-ish order
  function yearSortKey(col){
    const m = String(col.id).match(/(\d{4})/);
    return m ? Number(m[1]) : 9999;
  }
  returnCols.sort((a,b)=>yearSortKey(a)-yearSortKey(b));

  const metricCols = [
    { id: "annualised_excess", label: "Anual. (RF+)", kind: "metric", sort: "desc" },
    { id: "annualised_total", label: "Anual. Total", kind: "metric", sort: "desc" },
    { id: "vol", label: "Vol.", kind: "metric", sort: "desc" },
    { id: "sharpe", label: "Sharpe", kind: "metric", sort: "desc" },
    { id: "max_dd", label: "Máx DD", kind: "metric", sort: "desc" },
  ];

  return { returnCols, metricCols, annualisedCol, volCol, maxDDCol };
}

// Prepare merged dataset (Quantum + Registry) and computed metrics (RF+, Sharpe)
function prepareDataset(quantumRows, registryRows, datasetConfig, columns){
  // Normalize registry schema:
  // Accept either: asset/class/color  OR  asset/quantum_name/class/asset_color/class_color
  const regByQuantum = new Map();
  const regByAsset = new Map();

  for (const r of registryRows){
    const quantumName = r.quantum_name ?? r.quantumName ?? r.quantum ?? r["quantum name"] ?? "";
    const display = r.asset ?? r.display ?? r.name ?? "";
    const cls = r.class ?? r.asset_class ?? r.assetClass ?? "";
    const assetColor = r.asset_color ?? r.color ?? r.assetColor ?? "";
    const classColor = r.class_color ?? r.classColor ?? "";

    const out = {
      id: r.id ? String(r.id) : normalize(quantumName || display || cls || Math.random()),
      display: String(display || quantumName || "").trim(),
      quantum_name: String(quantumName || "").trim(),
      class: String(cls || "").trim(),
      asset_color: String(assetColor || "").trim(),
      class_color: String(classColor || "").trim(),
    };

    if (out.quantum_name) regByQuantum.set(normalize(out.quantum_name), out);
    if (out.display) regByAsset.set(normalize(out.display), out);
  }

  const assets = [];
  for (const row of quantumRows){
    const quantumName = String(row["Nome"] ?? "").trim();
    // Tenta casar primeiro por quantum_name; se não achar, tenta por display; se ainda não achar, tenta pegar o "ticker" depois de ' - '
    const tickerGuess = quantumName.includes(" - ") ? quantumName.split(" - ").pop().trim() : "";
    const reg = regByQuantum.get(normalize(quantumName))
      || regByAsset.get(normalize(quantumName))
      || (tickerGuess ? regByAsset.get(normalize(tickerGuess)) : null);

    const meta = reg ?? {
      id: normalize(quantumName),
      display: quantumName,
      quantum_name: quantumName,
      class: "",
      asset_color: "#e2e8f0",
      class_color: "",
    };

    const values = {};

    // Yearly / partial returns
    for (const c of columns.returnCols){
      values[c.id] = parseNumberPtBR(row[c.source]);
    }

    // Metrics from Quantum
    values.annualised_total = columns.annualisedCol ? parseNumberPtBR(row[columns.annualisedCol]) : null;
    values.vol = columns.volCol ? parseNumberPtBR(row[columns.volCol]) : null;
    values.max_dd = columns.maxDDCol ? parseNumberPtBR(row[columns.maxDDCol]) : null;

    assets.push({ ...meta, values, raw: row });
  }

  // Risk-free annualised total (e.g. CDI for BR, SOFR for EX)
  const rfKey = normalize(datasetConfig.riskFreeQuantumName);
  const rfAsset = assets.find(a => normalize(a.quantum_name) === rfKey || normalize(a.display) === rfKey);
  const rfAnnualised = rfAsset?.values?.annualised_total;

  // Compute annualised excess and Sharpe
  for (const a of assets){
    const ann = a.values.annualised_total;
    const vol = a.values.vol;
    const excess = (Number.isFinite(ann) && Number.isFinite(rfAnnualised)) ? (ann - rfAnnualised) : null;
    const sharpe = (Number.isFinite(excess) && Number.isFinite(vol) && vol !== 0) ? (excess / vol) : null;

    a.values.annualised_excess = excess;
    a.values.sharpe = sharpe;
  }

  // Subtitle: derive period from annualised header
  let periodText = "";
  if (columns.annualisedCol){
    const m = columns.annualisedCol.match(/\((.*?)\)/);
    if (m) periodText = m[1];
  }
  const subtitle = periodText
    ? `${datasetConfig.label} • Período: ${periodText} • RF: ${datasetConfig.riskFreeQuantumName}`
    : `${datasetConfig.label} • RF: ${datasetConfig.riskFreeQuantumName}`;

  // Ajusta o label do RF+ para ficar "CDI+" ou "SOFR+" automaticamente
  for (const c of columns.metricCols){
    if (c.id === "annualised_excess"){
      c.label = `Anual. (${datasetConfig.riskFreeQuantumName}+)`;
    }
  }

  const colDefs = [...columns.returnCols, ...columns.metricCols];

  return { assets, colDefs, subtitle, rfAnnualised, periodText, rfName: datasetConfig.riskFreeQuantumName };
}

// Layout computation
const CARD_H = 44;
const GAP = 8;

function rankAssets(assets, colId){
  // sort desc, nulls last
  const vals = assets.map(a => ({ id: a.id, v: a.values[colId] }));
  vals.sort((a,b)=>{
    const av = a.v; const bv = b.v;
    const aOk = Number.isFinite(av); const bOk = Number.isFinite(bv);
    if (!aOk && !bOk) return 0;
    if (!aOk) return 1;
    if (!bOk) return -1;
    return bv - av;
  });
  return vals.map(x => x.id);
}

function computePositions(dataset, displayMode, referenceAssetId){
  const { assets, colDefs } = dataset;
  const byId = new Map(assets.map(a=>[a.id,a]));

  // Precompute ranks per column
  const ranks = {};
  for (const col of colDefs){
    const ordered = rankAssets(assets, col.id);
    ranks[col.id] = ordered;
  }

  const positions = {}; // positions[colId][assetId] = { top, value }
  const baselines = {}; // baselines[colId] = y in px (for rendering a line)

  if (displayMode === "stacked"){
    for (const col of colDefs){
      const ordered = ranks[col.id];
      const colPos = {};
      ordered.forEach((assetId, idx)=>{
        colPos[assetId] = { top: idx*(CARD_H+GAP) };
      });
      positions[col.id] = colPos;
      baselines[col.id] = null;
    }
    const colHeight = assets.length*(CARD_H+GAP) - GAP;
    return { positions, baselines, height: colHeight };
  }

  if (displayMode === "zero"){
    // Each column baseline depends on how many positives it has
    let maxHeight = 0;
    for (const col of colDefs){
      const ordered = ranks[col.id].map(id => ({ id, v: byId.get(id)?.values[col.id] }));
      const pos = ordered.filter(x => Number.isFinite(x.v) && x.v >= 0).sort((a,b)=>b.v - a.v);
      const neg = ordered.filter(x => Number.isFinite(x.v) && x.v < 0).sort((a,b)=>b.v - a.v);

      const nPos = pos.length;
      const yBase = nPos*(CARD_H+GAP); // baseline position (px)

      const colPos = {};
      pos.forEach((x, idx)=>{
        colPos[x.id] = { top: idx*(CARD_H+GAP) };
      });
      neg.forEach((x, idx)=>{
        colPos[x.id] = { top: yBase + GAP + idx*(CARD_H+GAP) };
      });

      // Missing values: push to bottom after neg
      const missing = ordered.filter(x => !Number.isFinite(x.v)).map(x=>x.id);
      const startMissing = yBase + GAP + neg.length*(CARD_H+GAP) + GAP;
      missing.forEach((id, idx)=>{
        colPos[id] = { top: startMissing + idx*(CARD_H+GAP) };
      });

      positions[col.id] = colPos;
      baselines[col.id] = yBase - GAP/2;

      const colHeight = startMissing + missing.length*(CARD_H+GAP) - GAP;
      maxHeight = Math.max(maxHeight, colHeight);
    }
    return { positions, baselines, height: maxHeight };
  }

  if (displayMode === "asset"){
    // Compute relative rank to reference asset, using GLOBAL min/max across columns
    const refId = referenceAssetId;
    if (!refId){
      return computePositions(dataset, "stacked", null);
    }

    let globalMinRel = 0;
    let globalMaxRel = 0;

    // ranksIndex[colId][assetId] = index
    const rankIndex = {};
    for (const col of colDefs){
      const ordered = ranks[col.id];
      const idxMap = {};
      ordered.forEach((id, idx)=>{ idxMap[id]=idx; });
      rankIndex[col.id] = idxMap;

      const refRank = idxMap[refId];
      if (refRank === undefined) continue;

      for (const a of assets){
        const r = idxMap[a.id];
        if (r === undefined) continue;
        const rel = r - refRank;
        globalMinRel = Math.min(globalMinRel, rel);
        globalMaxRel = Math.max(globalMaxRel, rel);
      }
    }

    const span = globalMaxRel - globalMinRel;
    const height = (span + 1)*(CARD_H+GAP) - GAP;
    const baselineY = (0 - globalMinRel)*(CARD_H+GAP) - GAP/2;

    for (const col of colDefs){
      const idxMap = rankIndex[col.id];
      const refRank = idxMap[refId];
      const colPos = {};
      if (refRank === undefined){
        // If ref isn't in this column, fallback to stacked
        const ordered = ranks[col.id];
        ordered.forEach((id, idx)=>{ colPos[id] = { top: idx*(CARD_H+GAP) }; });
        positions[col.id] = colPos;
        baselines[col.id] = null;
        continue;
      }
      for (const a of assets){
        const r = idxMap[a.id];
        if (r === undefined) continue;
        const rel = r - refRank;
        const top = (rel - globalMinRel)*(CARD_H+GAP);
        colPos[a.id] = { top };
      }
      positions[col.id] = colPos;
      baselines[col.id] = baselineY;
    }

    return { positions, baselines, height };
  }

  return computePositions(dataset, "stacked", null);
}

// Color scale for Return highlight (diverging red -> yellow -> green)
function valueToColor(v, scale){
  if (!Number.isFinite(v)) return "#e2e8f0";
  const maxAbs = scale.maxAbs || 0.0001;
  const t = Math.max(0, Math.min(1, (v + maxAbs) / (2*maxAbs)));

  const c1 = [200, 29, 37];   // red-ish
  const c2 = [241, 196, 83];  // yellow-ish
  const c3 = [42, 157, 143];  // green-ish

  function lerp(a,b,t){ return a + (b-a)*t; }
  function mix(a,b,t){
    return [
      Math.round(lerp(a[0],b[0],t)),
      Math.round(lerp(a[1],b[1],t)),
      Math.round(lerp(a[2],b[2],t)),
    ];
  }

  let rgb;
  if (t < 0.5){
    rgb = mix(c1, c2, t/0.5);
  } else {
    rgb = mix(c2, c3, (t-0.5)/0.5);
  }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}


// Deterministic fallback color for a class (if class_color not provided)
function pickColorForClass(cls){
  const s = String(cls ?? "Sem classe");
  // simple hash
  let h = 0;
  for (let i=0;i<s.length;i++){
    h = (h*31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 55% 68%)`;
}

function computeReturnScale(dataset){
  const { assets, colDefs } = dataset;

  // Only use return-ish columns for scale (years + annualised_total + annualised_excess)
  const scaleCols = colDefs
    .filter(c => c.kind === "return" || c.id === "annualised_total" || c.id === "annualised_excess");

  let min = Infinity;
  let max = -Infinity;
  for (const a of assets){
    for (const c of scaleCols){
      const v = a.values[c.id];
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const maxAbs = Math.max(Math.abs(min), Math.abs(max));
  return { min, max, maxAbs };
}

function renderLegend(dataset){
  ui.legendRow.innerHTML = "";

  if (state.highlightMode === "return"){
    const wrap = document.createElement("div");
    wrap.className = "legend-gradient";
    wrap.innerHTML = `
      <span>Menor</span>
      <div class="gradient-bar" aria-hidden="true"></div>
      <span>Maior</span>
    `;
    ui.legendRow.appendChild(wrap);
    return;
  }

  // Asset class legend
  const classes = new Map();
  for (const a of dataset.assets){
    const cls = a.class || "Sem classe";
    const color = (a.class_color && a.class_color.trim()) ? a.class_color.trim() : pickColorForClass(cls);
    if (!classes.has(cls)) classes.set(cls, color);
  }

  for (const [cls, color] of classes.entries()){
    const chip = document.createElement("div");
    chip.className = "legend-chip";
    chip.innerHTML = `<span class="legend-swatch" style="background:${color}"></span><span>${cls}</span>`;
    ui.legendRow.appendChild(chip);
  }
}

// Tooltip
function showTooltip(ev, html){
  ui.tooltip.style.display = "block";
  ui.tooltip.innerHTML = html;
  moveTooltip(ev);
}
function moveTooltip(ev){
  const pad = 14;
  const rect = ui.tooltip.getBoundingClientRect();
  let x = ev.clientX + 14;
  let y = ev.clientY + 14;
  if (x + rect.width + pad > window.innerWidth) x = ev.clientX - rect.width - 14;
  if (y + rect.height + pad > window.innerHeight) y = ev.clientY - rect.height - 14;
  ui.tooltip.style.left = x + "px";
  ui.tooltip.style.top = y + "px";
}
function hideTooltip(){
  ui.tooltip.style.display = "none";
}

// Render chart
function renderChart(dataset){
  ui.subtitle.textContent = dataset.subtitle;
  ui.chart.innerHTML = "";

  // Populate reference asset select
  ui.refAssetSelect.innerHTML = "";
  dataset.assets.forEach(a=>{
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.display;
    ui.refAssetSelect.appendChild(opt);
  });

  if (!state.referenceAssetId){
    state.referenceAssetId = dataset.assets[0]?.id ?? null;
    ui.refAssetSelect.value = state.referenceAssetId ?? "";
  }

  renderLegend(dataset);

  const layout = computePositions(dataset, state.displayMode, state.referenceAssetId);

  // Class color map (uses class_color if provided, otherwise a deterministic fallback per class)
  const classColorMap = new Map();
  for (const a of dataset.assets){
    const cls = a.class || "Sem classe";
    const preferred = a.class_color && a.class_color.trim() ? a.class_color.trim() : null;
    if (!classColorMap.has(cls)){
      classColorMap.set(cls, preferred || pickColorForClass(cls));
    } else if (preferred){
      classColorMap.set(cls, preferred);
    }
  }

  // Compute return color scale once
  const retScale = computeReturnScale(dataset);

  // Build columns
  const cardsByAssetId = new Map(); // for hover highlight across columns

  for (const col of dataset.colDefs){
    const colEl = document.createElement("div");
    colEl.className = "column";

    const headerEl = document.createElement("div");
    headerEl.className = "col-header";
    headerEl.textContent = col.label;

    const bodyEl = document.createElement("div");
    bodyEl.className = "col-body";
    bodyEl.style.height = layout.height + "px";

    // Baseline line (for zero/asset modes)
    const baseY = layout.baselines[col.id];
    if (baseY !== null && baseY !== undefined){
      const line = document.createElement("div");
      line.className = "baseline";
      line.style.top = baseY + "px";
      bodyEl.appendChild(line);
    }

    // Cards
    for (const a of dataset.assets){
      const v = a.values[col.id];
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.assetId = a.id;
      card.dataset.colId = col.id;

      // Color
      let bg = "#e2e8f0";
      if (state.highlightMode === "class"){
        const cls = a.class || "Sem classe";
        bg = classColorMap.get(cls) || a.class_color || a.asset_color || "#e2e8f0";
      } else {
        bg = valueToColor(v, retScale);
      }
      card.style.background = bg;

      // Text
      const nameEl = document.createElement("div");
      nameEl.className = "name";
      nameEl.textContent = a.display;

      const valEl = document.createElement("div");
      valEl.className = "val";

      // Formatting per metric
      if (col.id === "sharpe"){
        valEl.textContent = fmtNum(v, 2);
      } else if (col.id === "vol"){
        valEl.textContent = fmtPct(v, 1);
      } else if (col.id === "max_dd"){
        valEl.textContent = fmtPct(v, 1);
      } else {
        // returns
        valEl.textContent = fmtPct(v, 1);
      }

      card.appendChild(nameEl);
      card.appendChild(valEl);

      // Position
      const top = layout.positions[col.id]?.[a.id]?.top ?? 0;
      card.style.transform = `translateY(${top}px)`;

      // Hover interactions
      card.addEventListener("mouseenter", (ev)=>{
        state.hoveredAssetId = a.id;
        updateHoverClasses(cardsByAssetId, a.id);
        const html = `
          <div class="t-title">${a.display}</div>
          <div class="t-row"><span>Coluna</span><span>${col.label}</span></div>
          <div class="t-row"><span>Valor</span><span>${(col.id === "sharpe") ? fmtNum(v,2) : fmtPct(v,1)}</span></div>
          <div class="t-row"><span>Anual. Total</span><span>${fmtPct(a.values.annualised_total,1)}</span></div>
          <div class="t-row"><span>Anual. (${dataset.rfName}+)</span><span>${fmtPct(a.values.annualised_excess,1)}</span></div>
          <div class="t-row"><span>Vol.</span><span>${fmtPct(a.values.vol,1)}</span></div>
          <div class="t-row"><span>Sharpe</span><span>${fmtNum(a.values.sharpe,2)}</span></div>
          <div class="t-row"><span>Máx DD</span><span>${fmtPct(a.values.max_dd,1)}</span></div>
        `;
        showTooltip(ev, html);
      });
      card.addEventListener("mousemove", (ev)=>{ moveTooltip(ev); });
      card.addEventListener("mouseleave", ()=>{
        state.hoveredAssetId = null;
        updateHoverClasses(cardsByAssetId, null);
        hideTooltip();
      });

      // Index in map
      if (!cardsByAssetId.has(a.id)) cardsByAssetId.set(a.id, []);
      cardsByAssetId.get(a.id).push(card);

      bodyEl.appendChild(card);
    }

    colEl.appendChild(headerEl);
    colEl.appendChild(bodyEl);
    ui.chart.appendChild(colEl);
  }
}

function updateHoverClasses(cardsByAssetId, hoveredId){
  // Clear all
  for (const [assetId, cards] of cardsByAssetId.entries()){
    for (const el of cards){
      el.classList.toggle("is-hovered", hoveredId && assetId === hoveredId);
      el.classList.toggle("is-dimmed", hoveredId && assetId !== hoveredId);
    }
  }
}

// Load and bootstrap
let cachedDatasets = new Map();

async function loadDataset(geo){
  if (cachedDatasets.has(geo)) return cachedDatasets.get(geo);

  const cfg = DATASETS[geo];
  const quantumUrl = `${cfg.folder}/CSV_Quantum.csv`;
  const registryUrl = `${cfg.folder}/asset_registry.csv`;

  const [quantumText, registryText] = await Promise.all([
    fetchText(quantumUrl),
    fetchText(registryUrl),
  ]);

  const quantumCSV = parseCSV(quantumText, ";");
  const registryCSV = parseCSV(registryText, ";");

  const cols = extractColumns(quantumCSV.header);
  const dataset = prepareDataset(quantumCSV.data, registryCSV.data, cfg, cols);

  cachedDatasets.set(geo, dataset);
  return dataset;
}

async function refresh(){
  try{
    const dataset = await loadDataset(state.geography);
    // Update select visibility
    ui.refAssetGroup.style.display = (state.displayMode === "asset") ? "block" : "none";
    renderChart(dataset);
  } catch (err){
    ui.chart.innerHTML = `
      <div style="padding: 14px; color:#b91c1c;">
        <strong>Não foi possível carregar os dados.</strong><br/>
        Verifique se os arquivos do dataset existem em <code>data/${state.geography}/</code>.<br/>
        <small>${String(err.message || err)}</small>
      </div>
    `;
    ui.subtitle.textContent = "Erro ao carregar dataset.";
  }
}

function wireUI(){
  // Geography
  btn.geoBr.addEventListener("click", ()=>{
    state.geography = "br";
    setActive(btn.geoBr, true); setActive(btn.geoEx, false);
    refresh();
  });
  btn.geoEx.addEventListener("click", ()=>{
    state.geography = "ex";
    setActive(btn.geoBr, false); setActive(btn.geoEx, true);
    refresh();
  });

  // Display mode
  btn.modeStacked.addEventListener("click", ()=>{
    state.displayMode = "stacked";
    setActive(btn.modeStacked, true); setActive(btn.modeZero, false); setActive(btn.modeAsset, false);
    refresh();
  });
  btn.modeZero.addEventListener("click", ()=>{
    state.displayMode = "zero";
    setActive(btn.modeStacked, false); setActive(btn.modeZero, true); setActive(btn.modeAsset, false);
    refresh();
  });
  btn.modeAsset.addEventListener("click", ()=>{
    state.displayMode = "asset";
    setActive(btn.modeStacked, false); setActive(btn.modeZero, false); setActive(btn.modeAsset, true);
    refresh();
  });

  // Highlight
  btn.hlClass.addEventListener("click", ()=>{
    state.highlightMode = "class";
    setActive(btn.hlClass, true); setActive(btn.hlReturn, false);
    refresh();
  });
  btn.hlReturn.addEventListener("click", ()=>{
    state.highlightMode = "return";
    setActive(btn.hlClass, false); setActive(btn.hlReturn, true);
    refresh();
  });

  // Reference asset
  ui.refAssetSelect.addEventListener("change", ()=>{
    state.referenceAssetId = ui.refAssetSelect.value || null;
    refresh();
  });
}

wireUI();
refresh();
