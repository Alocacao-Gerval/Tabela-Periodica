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
  highlightMode: "class", // class | asset | return
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
  // Pode não existir no HTML (nós criamos via JS se faltar)
  hlAsset: document.getElementById("hl-asset"),
  hlReturn: document.getElementById("hl-return"),
};

function setActive(el, active){
  el.classList.toggle("is-active", !!active);
}

// Deixa os highlights em PT-BR e cria o botão "Ativo" caso não exista no HTML
function initHighlightButtons(){
  // Renomeia labels
  if (btn.hlClass) btn.hlClass.textContent = "Classe";
  if (btn.hlReturn) btn.hlReturn.textContent = "Retorno";

  const group = document.querySelector('.segmented[aria-label="Highlight"]');
  if (!btn.hlAsset && group){
    const b = document.createElement("button");
    b.id = "hl-asset";
    b.type = "button";
    b.className = "segmented-btn";
    b.textContent = "Ativo";
    // Insere entre Classe e Retorno (se existir)
    if (btn.hlReturn) group.insertBefore(b, btn.hlReturn);
    else group.appendChild(b);
    btn.hlAsset = b;
  }
  if (btn.hlAsset) btn.hlAsset.textContent = "Ativo";
}

// Basic utilities
function normalize(str){
  return String(str ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\uFFFD/g, "")      // remove replacement char (quando CSV não é UTF-8)
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

  // (Opcional) retorno total do período completo (ex: 02/06/2015 até 31/12/2024)
  let totalReturnCol = null;

  for (const h of quantumHeader){
    const hs = String(h || "").trim();
    const hn = normalize(hs);

    // Retorno (anos / períodos)
    // Aceita "diária" e também CSV com encoding quebrado ("di�ria") via normalize()
    if (/^retorno\s*-\s*di.?ria\s*\(/.test(hn)){
      // (2016)
      const mYear = hs.match(/\((\d{4})\)/);
      if (mYear){
        returnCols.push({ id: mYear[1], label: mYear[1], source: hs, kind: "return" });
        continue;
      }

      // (02/06/2015 até 31/12/2015) etc
      const mRange = hs.match(/\((\d{2}\/\d{2}\/\d{4}).*?(\d{2}\/\d{2}\/\d{4})\)/);
      if (mRange){
        const start = mRange[1];
        const end = mRange[2];
        const startYear = start.slice(-4);
        const endYear = end.slice(-4);

        // Só vira "coluna de ano" se o período estiver contido no MESMO ano
        // (ex: 2015*). Se o período atravessa vários anos, isso é "retorno total do período"
        if (startYear === endYear){
          const isPartialYear = !start.startsWith("01/01") || !end.startsWith("31/12");
          const label = `${endYear}${isPartialYear ? "*" : ""}`;
          returnCols.push({ id: label, label, source: hs, kind: "return" });
        } else {
          totalReturnCol = hs;
        }
        continue;
      }
    }

    // Colunas de métricas (robusto a acentos/encoding)
    if (!annualisedCol && hn.includes("anualizado") && hn.includes("retorno")){
      annualisedCol = hs;
      continue;
    }
    if (!volCol && hn.includes("volatilidade")){
      volCol = hs;
      continue;
    }
    if (!maxDDCol && hn.includes("drawdown")){
      maxDDCol = hs;
      continue;
    }
  }

  // Sort returnCols by year-ish
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

  return { returnCols, metricCols, annualisedCol, volCol, maxDDCol, totalReturnCol };
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

  return {
    assets,
    colDefs,
    subtitle,
    rfAnnualised,
    periodText,
    rfName: datasetConfig.riskFreeQuantumName,
    rfAssetId: rfAsset?.id ?? null,
  };
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
    // Baseline (0%) alinhada ENTRE colunas (mesma altura), no estilo BlackRock
    let globalMinY = Infinity;
    let globalMaxY = -Infinity;
    const yMaps = {}; // yMaps[colId][assetId] = y (inteiro)

    for (const col of colDefs){
      const ordered = ranks[col.id].map(id => ({ id, v: byId.get(id)?.values[col.id] }));
      const pos = ordered.filter(x => Number.isFinite(x.v) && x.v >= 0).sort((a,b)=>b.v - a.v);
      const neg = ordered.filter(x => Number.isFinite(x.v) && x.v < 0).sort((a,b)=>b.v - a.v); // mais perto do zero primeiro
      const missing = ordered.filter(x => !Number.isFinite(x.v)).map(x => x.id);

      const colY = {};
      const nPos = pos.length;

      // Positivos: ficam ACIMA da linha do zero.
      // Queremos o melhor (maior retorno) mais "alto" => y mais negativo.
      pos.forEach((x, idx)=>{
        // idx=0 (melhor) => y=-nPos; idx=nPos-1 (pior positivo) => y=-1
        colY[x.id] = idx - nPos;
      });

      // Negativos: ficam ABAIXO da linha do zero.
      // Mais perto do zero vem primeiro (logo abaixo da linha).
      neg.forEach((x, idx)=>{
        colY[x.id] = idx + 1; // 1..nNeg
      });

      // Missing: depois de tudo
      missing.forEach((id, idx)=>{
        colY[id] = (neg.length + 1) + idx;
      });

      yMaps[col.id] = colY;

      for (const id in colY){
        const y = colY[id];
        globalMinY = Math.min(globalMinY, y);
        globalMaxY = Math.max(globalMaxY, y);
      }
    }

    if (globalMinY === Infinity){
      globalMinY = 0;
      globalMaxY = 0;
    }

    const height = (globalMaxY - globalMinY + 1)*(CARD_H+GAP) - GAP;
    const baselineY = (0 - globalMinY)*(CARD_H+GAP) - GAP/2;

    for (const col of colDefs){
      const colPos = {};
      const colY = yMaps[col.id] || {};
      for (const a of assets){
        const y = colY[a.id];
        if (y === undefined) continue;
        colPos[a.id] = { top: (y - globalMinY)*(CARD_H+GAP) };
      }
      positions[col.id] = colPos;
      baselines[col.id] = baselineY;
    }

    return { positions, baselines, height };
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

// Color scale for "Retorno" highlight
// Divergente: vermelho (abaixo do RF) -> amarelo (RF) -> verde (acima do RF)
// Para colunas onde "menor é melhor" (ex.: Vol.), usamos reverse=true.
function valueToColor(v, scale){
  if (!Number.isFinite(v) || !scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)){
    return "#e2e8f0";
  }

  // Paleta (mesma do prototype)
  const c1 = [200, 29, 37];    // red-ish
  const c2 = [241, 196, 83];   // yellow-ish (neutro)
  const c3 = [42, 157, 143];   // green-ish

  function lerp(a,b,t){ return a + (b-a)*t; }
  function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  function mix(a,b,t){
    return [
      Math.round(lerp(a[0],b[0],t)),
      Math.round(lerp(a[1],b[1],t)),
      Math.round(lerp(a[2],b[2],t)),
    ];
  }

  let min = scale.min;
  let max = scale.max;
  let pivot = scale.pivot;

  // Se menor for melhor (volatilidade), invertimos o eixo
  if (scale.reverse){
    const v2 = -v;
    const min2 = -max;
    const max2 = -min;
    const pivot2 = Number.isFinite(pivot) ? -pivot : pivot;
    v = v2; min = min2; max = max2; pivot = pivot2;
  }

  if (!Number.isFinite(pivot)) pivot = (min + max) / 2;
  // Garante pivot dentro do range
  pivot = Math.max(min, Math.min(max, pivot));

  // Caso degenerado
  if (max === min){
    return `rgb(${c2[0]},${c2[1]},${c2[2]})`;
  }

  // ===== MODO "BANDAS" (quantiza em degraus a partir do pivot) =====
  // Espera scale.bandStep e scale.bandCap (em unidades do teu v: ex. 0.02 = 2 p.p.)
  const bandStep = scale.bandStep;
  const bandCap  = scale.bandCap;
  const banded =
    Number.isFinite(bandStep) && bandStep > 0 &&
    Number.isFinite(bandCap)  && bandCap > 0;

  if (banded) {
    // distância até a "ponta" de cada lado, respeitando range real e o cap configurado
    const capBelow = Math.min(bandCap, Math.max(0, pivot - min));
    const capAbove = Math.min(bandCap, Math.max(0, max - pivot));

    // helper: transforma uma diferença em "degraus" (0..1)
    function quantize(diff, cap) {
      if (cap <= 0) return 0;
      const d = Math.max(0, Math.min(cap, diff));
      const q = Math.floor(d / bandStep) * bandStep; // degraus: 0, step, 2*step...
      return Math.max(0, Math.min(1, q / cap));
    }

    if (v <= pivot) {
      const t = quantize(pivot - v, capBelow); // 0 = pivot (amarelo), 1 = vermelho
      const rgb = mix(c2, c1, t);
      return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    } else {
      const t = quantize(v - pivot, capAbove); // 0 = pivot (amarelo), 1 = verde
      const rgb = mix(c2, c3, t);
      return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    }
  }
  
  // Segmento 1: min -> pivot (vermelho -> amarelo)
  if (v <= pivot){
    const denom = (pivot - min);
    const t = denom === 0 ? 1 : clamp01((v - min) / denom);
    const rgb = mix(c1, c2, t);
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // Segmento 2: pivot -> max (amarelo -> verde)
  const denom = (max - pivot);
  const t = denom === 0 ? 1 : clamp01((v - pivot) / denom);
  const rgb = mix(c2, c3, t);
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
  const { assets, colDefs, rfAssetId } = dataset;

  const scales = {};
  const rfAsset = rfAssetId ? assets.find(a => a.id === rfAssetId) : null;

  for (const col of colDefs){
    // 1) min/max reais da coluna
    let min = Infinity;
    let max = -Infinity;

    for (const a of assets){
      const v = a.values[col.id];
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }

    if (min === Infinity){
      scales[col.id] = { min: NaN, max: NaN, pivot: NaN, reverse: false };
      continue;
    }

    // 2) pivot (RF ou neutros especiais)
    let pivot = rfAsset ? rfAsset.values[col.id] : NaN;

    if (col.id === "annualised_excess") pivot = 0;
    if (col.id === "sharpe") pivot = 0;

    if (!Number.isFinite(pivot)) pivot = (min + max) / 2;

    // 3) reverse (menor é melhor)
    const reverse = (col.id === "vol");

    // 4) bandas (defaults)
    let bandStep = NaN;
    let bandCap  = NaN;

    // retornos por coluna-ano (col.kind existe: "return" / "metric")
    if (col.kind === "return"){
      bandStep = 0.00; // 2 p.p.
      bandCap  = 0.15; // satura em 30 p.p. vs pivot
      // diminuir bandCap (satura mais rápido) ou
      // diminuir bandStep (mais degraus, transição mais rápida).
    }

    // métricas
    if (col.id === "annualised_total"){  bandStep = 0.02; bandCap = 0.10; }
    if (col.id === "annualised_excess"){ bandStep = 0.00; bandCap = 0.05; }
    if (col.id === "sharpe"){           bandStep = 0.10; bandCap = 0.50; }
    if (col.id === "vol"){              bandStep = 0.02; bandCap = 0.20; } // reverse já cuida do sentido
    if (col.id === "max_dd"){           bandStep = 0.05; bandCap = 0.30; }

    scales[col.id] = { min, max, pivot, reverse, bandStep, bandCap };
  }

  return scales;
}

function renderLegend(dataset){
  ui.legendRow.innerHTML = "";

  if (state.highlightMode === "return"){
    const wrap = document.createElement("div");
    wrap.className = "legend-gradient";
    wrap.innerHTML = `
      <span>Abaixo do ${dataset.rfName}</span>
      <div class="gradient-bar" aria-hidden="true"></div>
      <span>Acima do ${dataset.rfName}</span>
    `;
    ui.legendRow.appendChild(wrap);
    return;
  }

  // Highlight por ativo: não exibimos legenda (pode ficar enorme)
  if (state.highlightMode === "asset"){
    return;
  }

  // Legend por classe
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

  const hasRef = !!state.referenceAssetId && dataset.assets.some(a => a.id === state.referenceAssetId);
  if (!hasRef){
    state.referenceAssetId = dataset.assets[0]?.id ?? null;
  }
  ui.refAssetSelect.value = state.referenceAssetId ?? "";

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
  window.scales = retScale;
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
        bg = classColorMap.get(cls) || a.class_color || "#e2e8f0";
      } else if (state.highlightMode === "asset"){
        // Cor por ativo (asset_color do registry)
        bg = (a.asset_color && a.asset_color.trim()) ? a.asset_color.trim() : "#e2e8f0";
      } else {
        // Retorno: escala divergente com pivot no RF
        bg = valueToColor(v, retScale[col.id]);
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
    setActive(btn.hlClass, true);
    if (btn.hlAsset) setActive(btn.hlAsset, false);
    setActive(btn.hlReturn, false);
    refresh();
  });
  if (btn.hlAsset){
    btn.hlAsset.addEventListener("click", ()=>{
      state.highlightMode = "asset";
      setActive(btn.hlClass, false);
      setActive(btn.hlAsset, true);
      setActive(btn.hlReturn, false);
      refresh();
    });
  }
  btn.hlReturn.addEventListener("click", ()=>{
    state.highlightMode = "return";
    setActive(btn.hlClass, false);
    if (btn.hlAsset) setActive(btn.hlAsset, false);
    setActive(btn.hlReturn, true);
    refresh();
  });

  // Reference asset
  ui.refAssetSelect.addEventListener("change", ()=>{
    state.referenceAssetId = ui.refAssetSelect.value || null;
    refresh();
  });
}

initHighlightButtons();
wireUI();
refresh();
