'use strict';

/* =====================================================================
   Nordvia finance knowledge graph - explorer
   Talks to /sparql (read only). The five competency queries are the
   files in queries/*.rq, read through /api/queries, so what is shown
   on screen is exactly what is run.
   ===================================================================== */

// ---------------------------------------------------------------- palette
const C = {
  navy: '#0d2748', blue: '#284d7d', ink: '#1b2a3f', ink2: '#52606f', muted: '#8a94a1',
  grid: '#e4e8ee', axis: '#c9d0da', surface: '#ffffff',
  seq: ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'],
  cat: ['#2a78d6', '#eb6834', '#1baf7a'],            // companies 1000, 2000, 3000 (fixed order)
  age: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'],   // ordinal ramp: not yet due -> over 90 days
};
const COMPANY_ORDER = ['1000', '2000', '3000'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PREFIXES = {
  'https://nordvia.com/ontology/finance#': 'nvf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
  'http://www.w3.org/2000/01/rdf-schema#': 'rdfs', 'http://www.w3.org/2002/07/owl#': 'owl',
  'http://www.w3.org/2001/XMLSchema#': 'xsd', 'http://www.w3.org/2004/02/skos/core#': 'skos',
  'http://purl.org/dc/terms/': 'dcterms', 'http://xmlns.com/foaf/0.1/': 'foaf',
  'http://www.w3.org/ns/org#': 'org', 'http://www.w3.org/ns/regorg#': 'rov', 'https://schema.org/': 'schema',
};

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function s(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur0 = v => (v < 0 ? '−€' : '€') + nf0.format(Math.abs(v));
const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

function compact(v) {
  const a = Math.abs(v);
  const tidy = x => x.replace(/\.0$/, '');
  if (a >= 1e6) return tidy((v / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + 'M';
  if (a >= 1e4) return tidy((v / 1e3).toFixed(a >= 1e5 ? 0 : 1)) + 'K';
  return nf0.format(v);
}

function niceScale(min, max, count = 5) {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

function rbar(x, y, w, hgt, r) {          // bar rounded on its right end only
  r = Math.max(0, Math.min(r, w, hgt / 2));
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

function mixColor(stops, t) {             // interpolate along a list of hex colours, t in 0..1
  t = Math.max(0, Math.min(1, t));
  const pos = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = stops[i].match(/\w\w/g).map(x => parseInt(x, 16));
  const b = stops[i + 1].match(/\w\w/g).map(x => parseInt(x, 16));
  return '#' + a.map((x, k) => Math.round(x + (b[k] - x) * f).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- state
const state = { company: 'all', topN: 10, keyDate: '2025-12-31', q5Company: 'all', bucket: 'all' };
let Q = {};            // competency queries by id
let COMP = {};         // company code -> {name, cur}
let cleanups = [];
let pendingConsole = null;

const shortCo = id => `${id} · ${(COMP[id]?.name || '').split(' ')[2] || ''}`.trim();
const coColor = id => C.cat[Math.max(0, COMPANY_ORDER.indexOf(id))] || C.cat[0];

// ---------------------------------------------------------------- data layer
const cache = new Map();

async function sparql(text) {
  const res = await fetch('/sparql', { method: 'POST', headers: { 'Content-Type': 'application/sparql-query' }, body: text });
  const body = await res.text();
  if (!res.ok) throw new Error(body);
  const j = JSON.parse(body);
  if (j.boolean !== undefined) return { vars: ['result'], rows: [{ result: j.boolean }], bindings: [], ms: j.ms };
  const vars = j.head.vars;
  const rows = j.results.bindings.map(b => {
    const o = {};
    for (const v of vars) o[v] = b[v] ? typed(b[v]) : null;
    return o;
  });
  return { vars, rows, bindings: j.results.bindings, ms: j.ms };
}

function typed(t) {
  if (t.type === 'literal' && /#(integer|int|long|decimal|double|float)$/.test(t.datatype || '')) return Number(t.value);
  return t.value;
}

function ask(text) {
  if (!cache.has(text)) {
    const p = sparql(text);
    cache.set(text, p);
    p.catch(() => cache.delete(text));
  }
  return cache.get(text);
}

function parseHeader(text) {
  const head = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) head.push(line.replace(/^#\s?/, ''));
    else break;
  }
  const first = head.shift() || '';
  const m = first.match(/^CQ(\d)\s*-\s*(.*)$/);
  return { no: m ? +m[1] : 0, question: (m ? m[2] : first).replace(/ - /g, ' – '), notes: head.join('\n').trim() };
}

const withKeyDate = (text, date) => text.replace(/"\d{4}-\d{2}-\d{2}T00:00:00"\^\^xsd:dateTime/, `"${date}T00:00:00"^^xsd:dateTime`);

// ---------------------------------------------------------------- tooltip
const tip = $('#tip');
function showTip(ev, title, rows) {
  tip.replaceChildren(
    h('div', { class: 'tt-title' }, title),
    ...rows.map(r => h('div', { class: 'tt-row' },
      r.key ? h('span', { class: 'tt-key', style: `background:${r.key}` }) : null,
      h('span', { class: 'tt-val' }, r.value), h('span', { class: 'tt-lab' }, r.label))));
  tip.style.display = 'block';
  moveTip(ev);
}
function moveTip(ev) {
  const pad = 14, r = tip.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { tip.style.display = 'none'; };
function bindTip(el, title, rows) {
  el.addEventListener('pointerenter', e => showTip(e, title, rows));
  el.addEventListener('pointermove', moveTip);
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); showTip({ clientX: b.left + b.width / 2, clientY: b.top }, title, rows); });
  el.addEventListener('blur', hideTip);
}

// ---------------------------------------------------------------- generic UI pieces
function pageHead(eyebrow, title, lede) {
  const isQ = /^Competency question/.test(eyebrow);
  return h('div', null, h('div', { class: 'eyebrow' }, eyebrow),
    h('h1', { class: isQ ? 'question' : null }, title), lede ? h('p', { class: 'lede' }, lede) : null);
}

function field(label, control) {
  const id = 'f' + Math.random().toString(36).slice(2, 8);
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control);
}

function select(options, value, onchange) {
  const el = h('select', { onchange: e => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
  return el;
}

function companySelect(key, onchange) {
  const opts = [['all', 'All companies'], ...COMPANY_ORDER.filter(c => COMP[c]).map(c => [c, `${c} · ${COMP[c].name} (${COMP[c].cur})`])];
  return select(opts, state[key], v => { state[key] = v; onchange(); });
}

function tile({ label, value, unit, note, href, q }) {
  const body = [
    q ? h('div', { class: 'q' }, q) : null,
    h('div', { class: 'lab' }, label),
    h('div', { class: 'val' + (String(value).length > 12 ? ' long' : '') }, value, unit ? h('small', null, unit) : null),
    note ? h('div', { class: 'note' }, note) : null,
  ];
  return href ? h('a', { class: 'tile', href }, body) : h('div', { class: 'tile' }, body);
}

function legend(items) {
  return h('div', { class: 'legend' }, items.map(i =>
    h('span', null, h('span', { class: i.type || 'sw', style: `background:${i.color}` }), i.label)));
}

function seg(options, value, onchange) {
  const wrap = h('div', { class: 'seg', role: 'tablist' });
  const buttons = options.map(([v, label]) => {
    const b = h('button', { type: 'button', role: 'tab', class: v === value ? 'on' : '', onclick: () => { buttons.forEach(x => x.classList.remove('on')); b.classList.add('on'); onchange(v); } }, label);
    return b;
  });
  wrap.append(...buttons);
  return wrap;
}

function mountChart(box, draw) {
  let last = 0;
  const render = () => {
    const w = Math.max(360, Math.floor(box.clientWidth));
    if (w === last && box.firstChild) return;
    last = w;
    box.replaceChildren(draw(w));
  };
  render();
  const ro = new ResizeObserver(() => requestAnimationFrame(render));
  ro.observe(box);
  cleanups.push(() => ro.disconnect());
  return { redraw: () => { last = 0; render(); } };
}

// A card with a Chart / Table switch. `draw(width)` returns an SVG, `tableEl` the table twin.
function chartCard({ title, sub, legendEl, draw, tableEl, footnote }) {
  const chartBox = h('div', { class: 'chart' });
  const paneChart = h('div', null, legendEl, chartBox, footnote ? h('p', { class: 'sub', style: 'margin:10px 0 0' }, footnote) : null);
  const paneTable = h('div', { style: 'display:none' }, tableEl);
  const card = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
      seg([['chart', 'Chart'], ['table', 'Table']], 'chart', v => {
        paneChart.style.display = v === 'chart' ? '' : 'none';
        paneTable.style.display = v === 'table' ? '' : 'none';
      })),
    paneChart, paneTable);
  const chart = mountChart(chartBox, draw);
  return { el: card, chartBox, redraw: chart.redraw };
}

function csvEscape(v) { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
function downloadCSV(name, header, rows) {
  const text = [header.map(csvEscape).join(','), ...rows.map(r => r.map(csvEscape).join(','))].join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

function dataTable(cols, rows, o = {}) {
  const st = { sort: o.sort || null, dir: o.dir || 'desc', q: '', limit: o.pageSize || 50 };
  const root = h('div');
  const body = h('div');
  const search = o.search ? h('input', { type: 'search', placeholder: o.searchLabel || 'Search…', 'aria-label': 'Search', oninput: e => { st.q = e.target.value.trim().toLowerCase(); st.limit = o.pageSize || 50; draw(); } }) : null;
  const count = h('span', { class: 'sub' });
  const exportBtn = h('button', { class: 'btn', type: 'button', onclick: () => downloadCSV(o.csv || 'table.csv', cols.map(c => c.label), view().map(r => cols.map(c => r[c.key]))) }, 'Export CSV');
  root.append(h('div', { class: 'tbar' }, h('div', { style: 'display:flex;gap:12px;align-items:center' }, search, count), exportBtn), body);

  const cmp = (a, b) => (a == null ? -1 : b == null ? 1 : typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true }));
  function view() {
    let rs = rows;
    if (st.q) rs = rs.filter(r => (o.search || []).some(k => String(r[k] ?? '').toLowerCase().includes(st.q)));
    if (st.sort) rs = [...rs].sort((a, b) => cmp(a[st.sort], b[st.sort]) * (st.dir === 'asc' ? 1 : -1));
    return rs;
  }
  function draw() {
    const rs = view();
    const shown = rs.slice(0, st.limit);
    count.textContent = `${nf0.format(rs.length)} row${rs.length === 1 ? '' : 's'}`;
    const head = h('tr', null, cols.map(c => h('th', {
      class: (c.num ? 'num ' : '') + (c.sortable === false ? '' : 'sortable'),
      onclick: c.sortable === false ? null : () => { if (st.sort === c.key) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = c.key; st.dir = c.num ? 'desc' : 'asc'; } draw(); },
    }, c.label, st.sort === c.key ? h('span', { class: 'arrow' }, st.dir === 'asc' ? '↑' : '↓') : null)));
    const trs = shown.map(r => h('tr', null, cols.map(c => h('td', { class: (c.num ? 'num ' : '') + (c.cls || '') }, c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '')))));
    body.replaceChildren(...[
      h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', null, head), h('tbody', null, trs))),
      rs.length > shown.length ? h('div', { class: 'more' }, `Showing ${shown.length} of ${nf0.format(rs.length)}`,
        h('button', { class: 'link', type: 'button', onclick: () => { st.limit += 100; draw(); } }, 'Show 100 more'),
        h('button', { class: 'link', type: 'button', onclick: () => { st.limit = rs.length; draw(); } }, 'Show all')) : null,
    ].filter(Boolean));
  }
  draw();
  return root;
}

function highlight(text) {
  return esc(text).split('\n').map(line => {
    if (/^\s*#/.test(line)) return `<span class="c">${line}</span>`;
    return line
      .replace(/(&quot;[^&]*?&quot;(\^\^[\w:]+)?)/g, '<span class="v">$1</span>')
      .replace(/\b(PREFIX|SELECT|WHERE|FILTER|OPTIONAL|BIND|VALUES|GROUP BY|ORDER BY|DESC|ASC|NOT EXISTS|EXISTS|UNION|LIMIT|DISTINCT|AS|IF|COALESCE|SUM|COUNT|AVG|MIN|MAX|STR|STRAFTER|FLOOR|YEAR|MONTH|DAY|BOUND|ASK)\b/g, '<span class="k">$1</span>')
      .replace(/(?<![\w"/])([a-z]+:[A-Za-z_][\w\-]*(?:\/[A-Za-z_][\w\-]*)*)/g, '<span class="p">$1</span>');
  }).join('\n');
}

function foldNotes(q) {
  return h('details', { class: 'fold' },
    h('summary', null, 'How it is answered, and the assumptions made'),
    h('div', { class: 'inner' }, h('p', { class: 'notes' }, q.notes || 'No notes.')));
}

function foldQuery(getText, title = 'The SPARQL query') {
  const pre = h('pre', { class: 'code' });
  const fold = h('details', { class: 'fold' },
    h('summary', null, title),
    h('div', { class: 'inner' }, pre,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: e => { navigator.clipboard?.writeText(getText()); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1200); } }, 'Copy'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { pendingConsole = getText(); location.hash = '#/console'; } }, 'Open in the console'))));
  const set = () => { pre.innerHTML = highlight(getText()); };
  set();
  return { el: fold, refresh: set };
}

const busy = (els, on) => els.forEach(e => e.classList.toggle('busy', on));

// ---------------------------------------------------------------- chart: ranked horizontal bars
function drawHBars(w, items, { valueFmt = nf2.format, color = C.cat[0], unit = 'EUR', axisTitle = '' } = {}) {
  const labelW = Math.min(300, Math.max(160, Math.round(w * 0.3)));
  const right = 92, top = 24, bottom = 48, rowH = 32, barH = 20;
  const plotW = Math.max(120, w - labelW - right);
  const H = top + items.length * rowH + bottom;
  const max = niceScale(0, Math.max(1, ...items.map(i => i.value))).hi;
  const sc = niceScale(0, max);
  const svg = s('svg', { width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'img', 'aria-label': 'Ranked horizontal bar chart' });
  for (const t of sc.ticks) {
    const x = labelW + plotW * t / sc.hi;
    svg.append(s('line', { x1: x, x2: x, y1: top - 8, y2: H - bottom, stroke: C.grid }));
    svg.append(s('text', { x, y: H - bottom + 18, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, sc.hi >= 1e4 ? compact(t) : nf0.format(t)));
  }
  svg.append(s('line', { x1: labelW, x2: labelW, y1: top - 8, y2: H - bottom, stroke: C.axis }));
  items.forEach((it, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    const bw = Math.max(2, plotW * it.value / sc.hi);
    svg.append(s('text', { x: labelW - 12, y: y + barH / 2 + 4, 'text-anchor': 'end', 'font-size': 12.5, fill: C.ink }, clip(it.label, Math.floor((labelW - 16) / 6.6))));
    const bar = s('path', { d: rbar(labelW, y, bw, barH, 4), fill: color, class: 'mark', tabindex: 0, 'aria-label': `${it.label}: ${valueFmt(it.value)} ${unit}` });
    bindTip(bar, it.label, it.tip || [{ value: valueFmt(it.value), label: unit }]);
    svg.append(bar);
    svg.append(s('text', { x: labelW + bw + 8, y: y + barH / 2 + 4, 'font-size': 12, fill: C.ink2, 'font-weight': 600 }, valueFmt(it.value)));
  });
  if (axisTitle) svg.append(s('text', { x: labelW + plotW / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11.5, fill: C.ink2 }, axisTitle));
  return svg;
}

// ---------------------------------------------------------------- chart: stacked horizontal bars
function drawStacked(w, rows, segmentsMeta, { axisTitle = '' } = {}) {
  // rows: [{label, total, segs:[{key, value, tip}]}]; segmentsMeta: [{key,label,color}]
  const labelW = Math.min(200, Math.max(120, Math.round(w * 0.18)));
  const right = 96, top = 20, bottom = 50, rowH = 52, barH = 24;
  const plotW = Math.max(160, w - labelW - right);
  const H = top + rows.length * rowH + bottom;
  const max = Math.max(1, ...rows.map(r => r.total));
  const sc = niceScale(0, max);
  const svg = s('svg', { width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'img', 'aria-label': 'Receivables by debt age and company' });
  for (const t of sc.ticks) {
    const x = labelW + plotW * t / sc.hi;
    svg.append(s('line', { x1: x, x2: x, y1: top - 6, y2: H - bottom, stroke: C.grid }));
    svg.append(s('text', { x, y: H - bottom + 18, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, sc.hi >= 1e4 ? compact(t) : nf0.format(t)));
  }
  svg.append(s('line', { x1: labelW, x2: labelW, y1: top - 6, y2: H - bottom, stroke: C.axis }));
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    svg.append(s('text', { x: labelW - 12, y: y + barH / 2 + 4, 'text-anchor': 'end', 'font-size': 12.5, fill: C.ink }, r.label));
    let cum = 0;
    const live = r.segs.filter(g => g.value > 0);
    live.forEach((g, k) => {
      const meta = segmentsMeta.find(m => m.key === g.key);
      const sw = plotW * g.value / sc.hi;
      const x = labelW + plotW * cum / sc.hi;
      const last = k === live.length - 1;
      const gap = k === 0 ? 0 : 2;
      const wi = Math.max(1, sw - gap);
      const el = last ? s('path', { d: rbar(x + gap, y, wi, barH, 4), fill: meta.color, class: 'mark', tabindex: 0 })
        : s('rect', { x: x + gap, y, width: wi, height: barH, fill: meta.color, class: 'mark', tabindex: 0 });
      el.setAttribute('aria-label', `${r.label}, ${meta.label}: ${nf2.format(g.value)} EUR`);
      bindTip(el, `${r.label} · ${meta.label}`, g.tip);
      svg.append(el);
      const text = compact(g.value);
      if (wi > text.length * 7 + 14) svg.append(s('text', { x: x + gap + wi / 2, y: y + barH / 2 + 4, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 600, fill: '#fff', 'pointer-events': 'none' }, text));
      cum += g.value;
    });
    svg.append(s('text', { x: labelW + plotW * r.total / sc.hi + 8, y: y + barH / 2 + 4, 'font-size': 12, 'font-weight': 600, fill: C.ink2 }, nf0.format(r.total)));
  });
  if (axisTitle) svg.append(s('text', { x: labelW + plotW / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11.5, fill: C.ink2 }, axisTitle));
  return svg;
}

// ---------------------------------------------------------------- chart: heat map
function drawHeat(w, rowsDef, cols, value, { cellTip, unit = 'EUR', rowHead = '', totalLabel = 'Total' } = {}) {
  const labelW = Math.min(250, Math.max(160, Math.round(w * 0.22)));
  const totalW = 78, top = 104, rowH = 26, bottom = 40;
  const plotW = Math.max(220, w - labelW - totalW - 6);
  const cw = plotW / cols.length;
  const H = top + rowsDef.length * rowH + bottom;
  let max = 0;
  for (const r of rowsDef) for (const c of cols) max = Math.max(max, value(r, c));
  const svg = s('svg', { width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'img', 'aria-label': 'Heat map of cost by cost centre and expense type' });
  cols.forEach((c, j) => {
    svg.append(s('text', { transform: `translate(${labelW + j * cw + cw / 2 - 4},${top - 8}) rotate(-38)`, 'text-anchor': 'start', 'font-size': 12, fill: C.ink2 }, c));
  });
  svg.append(s('text', { x: labelW + plotW + totalW - 4, y: top - 10, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: C.ink2 }, totalLabel));
  rowsDef.forEach((r, i) => {
    const y = top + i * rowH;
    svg.append(s('text', { x: labelW - 10, y: y + rowH / 2 + 3, 'text-anchor': 'end', 'font-size': 12.5, fill: r.muted ? C.muted : C.ink }, clip(r.label, Math.floor((labelW - 14) / 6.6))));
    let total = 0;
    cols.forEach((c, j) => {
      const v = value(r, c);
      total += v;
      const x = labelW + j * cw;
      if (v <= 0) {
        svg.append(s('rect', { x: x + 1, y: y + 1, width: cw - 2, height: rowH - 2, rx: 3, fill: '#f6f8fb' }));
        return;
      }
      const t = Math.sqrt(v / max);
      const cell = s('rect', { x: x + 1, y: y + 1, width: cw - 2, height: rowH - 2, rx: 3, fill: mixColor(C.seq, t), class: 'mark', tabindex: 0 });
      cell.setAttribute('aria-label', `${r.label}, ${c}: ${nf2.format(v)} ${unit}`);
      bindTip(cell, `${r.label}`, cellTip ? cellTip(r, c, v) : [{ value: nf2.format(v), label: `EUR · ${c}` }]);
      svg.append(cell);
      const text = compact(v);
      if (cw - 2 > text.length * 7 + 10) svg.append(s('text', { x: x + cw / 2, y: y + rowH / 2 + 4, 'text-anchor': 'middle', 'font-size': 11, fill: t > 0.5 ? '#fff' : C.ink, 'pointer-events': 'none' }, text));
    });
    svg.append(s('text', { x: labelW + plotW + totalW - 4, y: y + rowH / 2 + 4, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: C.ink }, nf0.format(total)));
  });
  // colour scale
  const gy = H - 22, gx = labelW, gw = Math.min(260, plotW * 0.5);
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  const defs = s('defs', null, s('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 },
    ...Array.from({ length: 9 }, (_, k) => s('stop', { offset: k / 8, 'stop-color': mixColor(C.seq, Math.sqrt(k / 8)) }))));
  svg.append(defs, s('rect', { x: gx, y: gy, width: gw, height: 8, rx: 4, fill: `url(#${gid})` }),
    s('text', { x: gx, y: gy + 22, 'font-size': 11, fill: C.muted }, '0'),
    s('text', { x: gx + gw, y: gy + 22, 'font-size': 11, fill: C.muted, 'text-anchor': 'end' }, `${compact(max)} ${unit}`),
    s('text', { x: gx + gw + 12, y: gy + 8, 'font-size': 11, fill: C.muted }, 'square-root colour scale'));
  return svg;
}

// ---------------------------------------------------------------- chart: dumbbell (terms vs actual)
function drawDumbbell(w, items) {
  const labelW = Math.min(220, Math.max(140, Math.round(w * 0.22)));
  const right = 70, top = 22, bottom = 50, rowH = 48;
  const plotW = Math.max(160, w - labelW - right);
  const H = top + items.length * rowH + bottom;
  const sc = niceScale(0, Math.max(...items.map(i => Math.max(i.terms, i.actual))) * 1.08, 7);
  const svg = s('svg', { width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'img', 'aria-label': 'Agreed payment terms against actual days to pay' });
  for (const t of sc.ticks) {
    const x = labelW + plotW * t / sc.hi;
    svg.append(s('line', { x1: x, x2: x, y1: top - 8, y2: H - bottom, stroke: C.grid }));
    svg.append(s('text', { x, y: H - bottom + 18, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, nf0.format(t)));
  }
  svg.append(s('text', { x: labelW + plotW / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11.5, fill: C.ink2 }, 'days from the baseline date'));
  svg.append(s('line', { x1: labelW, x2: labelW, y1: top - 8, y2: H - bottom, stroke: C.axis }));
  items.forEach((it, i) => {
    const y = top + i * rowH + rowH / 2;
    const x1 = labelW + plotW * it.terms / sc.hi, x2 = labelW + plotW * it.actual / sc.hi;
    svg.append(s('text', { x: labelW - 12, y: y - 2, 'text-anchor': 'end', 'font-size': 12.5, fill: C.ink }, it.label));
    svg.append(s('text', { x: labelW - 12, y: y + 13, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, it.sub));
    svg.append(s('line', { x1, x2, y1: y, y2: y, stroke: '#9ec5f4', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    svg.append(s('circle', { cx: x1, cy: y, r: 5, fill: C.age[0], stroke: C.surface, 'stroke-width': 2 }));
    svg.append(s('circle', { cx: x2, cy: y, r: 5, fill: C.age[3], stroke: C.surface, 'stroke-width': 2 }));
    svg.append(s('text', { x: Math.max(x1, x2) + 12, y: y + 4, 'font-size': 12, 'font-weight': 600, fill: C.ink2 }, `${nf1.format(it.actual)} d`));
    const hit = s('rect', { x: 0, y: y - rowH / 2, width: w, height: rowH, fill: 'transparent', tabindex: 0, 'aria-label': `${it.label}: ${nf1.format(it.actual)} days to pay against ${it.terms} agreed` });
    bindTip(hit, it.label, it.tip);
    svg.append(hit);
  });
  return svg;
}

// ---------------------------------------------------------------- chart: lines with crosshair
function drawLines(w, series, { yTitle = '' } = {}) {
  // series: [{id,label,color,values:[12 numbers|null]}]
  const left = 64, right = 20, top = 16, bottom = 34, H = 340;
  const plotW = w - left - right, plotH = H - top - bottom;
  const all = series.flatMap(sr => sr.values.filter(v => v != null));
  const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all), 6);
  const X = i => left + plotW * (i + 0.5) / 12;
  const Y = v => top + plotH * (1 - (v - sc.lo) / (sc.hi - sc.lo));
  const svg = s('svg', { width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'img', 'aria-label': 'Monthly profit and loss by company in euros' });
  for (const t of sc.ticks) {
    svg.append(s('line', { x1: left, x2: w - right, y1: Y(t), y2: Y(t), stroke: t === 0 ? C.axis : C.grid }));
    svg.append(s('text', { x: left - 10, y: Y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, (Math.max(Math.abs(sc.lo), Math.abs(sc.hi)) >= 1e4) ? compact(t) : nf0.format(t)));
  }
  MONTHS.forEach((m, i) => svg.append(s('text', { x: X(i), y: H - bottom + 20, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, m)));
  if (yTitle) svg.append(s('text', { x: 0, y: top - 4, 'font-size': 11, fill: C.muted }, yTitle));
  for (const sr of series) {
    const pts = sr.values.map((v, i) => (v == null ? null : [X(i), Y(v)]));
    const d = pts.map((p, i) => (p ? `${pts[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : '')).join('');
    svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  const cross = s('line', { y1: top, y2: top + plotH, stroke: C.axis, 'pointer-events': 'none', visibility: 'hidden' });
  svg.append(cross);
  const dots = series.map(sr => { const c = s('circle', { r: 5, fill: sr.color, stroke: C.surface, 'stroke-width': 2, visibility: 'hidden', 'pointer-events': 'none' }); svg.append(c); return c; });
  const hit = s('rect', { x: left, y: top, width: plotW, height: plotH, fill: 'transparent', tabindex: 0, 'aria-label': 'Monthly result by company; use the Table view for the figures' });
  const at = i => {
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    series.forEach((sr, k) => { const v = sr.values[i]; if (v == null) dots[k].setAttribute('visibility', 'hidden'); else { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('visibility', 'visible'); } });
    return series.map(sr => ({ key: sr.color, value: sr.values[i] == null ? '*' : nf2.format(sr.values[i]), label: sr.label }));
  };
  hit.addEventListener('pointermove', e => {
    const r = hit.getBoundingClientRect();
    const i = Math.max(0, Math.min(11, Math.floor((e.clientX - r.left) / r.width * 12)));
    showTip(e, `${MONTHS[i]} 2025 · result in EUR`, at(i));
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); hideTip(); });
  svg.append(hit);
  return svg;
}

// ================================================================= VIEWS

// ---------------------------------------------------------------- CQ1
async function viewCQ1(view) {
  const q = Q.cq1;
  let data = null;
  let text = withKeyDate(q.text, state.keyDate);
  const fq = foldQuery(() => text);
  const filters = h('div', { class: 'filters' });
  const tiles = h('div', { class: 'tiles' });
  const host = h('div');
  const detail = h('div');
  const bucketNames = { 0: 'Not yet due', 1: '1–30 days', 31: '31–60 days', 61: '61–90 days', 91: 'Over 90 days' };
  const bucketOrder = [0, 1, 31, 61, 91];
  const segMeta = bucketOrder.map((o, i) => ({ key: o, label: bucketNames[o], color: C.age[i] }));
  const pick = v => { state.bucket = v === 'all' ? 'all' : +v; ageSel.value = String(state.bucket); update(); };
  const ageSel = select([['all', 'All ages'], ...bucketOrder.map(o => [o, bucketNames[o]])], state.bucket, pick);

  view.append(pageHead('Competency question 1', q.question,
    'Open customer items at the key date, grouped by how many days they are past their due date. Credit memos that have not been applied are shown apart, because they have no age.'),
    filters, tiles, host, detail, foldNotes(q), fq.el);

  filters.append(
    field('Key date', h('input', { type: 'date', value: state.keyDate, min: '2025-01-31', max: '2025-12-31', onchange: async e => { if (!e.target.value) return; state.keyDate = e.target.value; await load(); } })),
    field('Company', companySelect('company', update)),
    field('Debt age', ageSel));

  async function load() {
    busy([tiles, host], true);
    text = withKeyDate(q.text, state.keyDate);
    fq.refresh();
    data = await ask(text);
    busy([tiles, host], false);
    update();
  }

  function update() {
    const base = data.rows.filter(r => state.company === 'all' || r.company === state.company);
    const sel = state.bucket;                                   // 'all' or one bucket order
    const rows = sel === 'all' ? base : base.filter(r => r.bucketOrder === sel);
    const at = o => base.filter(r => r.bucketOrder === o);
    const owed = sum(base.filter(r => r.bucketOrder < 999), r => r.amountEur);
    const credits = sum(at(999), r => r.amountEur);
    const customers = new Set(rows.map(r => r.company + r.customerNumber)).size;
    if (sel === 'all') {
      const net = sum(base, r => r.amountEur);
      const overdue = sum(base.filter(r => r.bucketOrder >= 1 && r.bucketOrder < 999), r => r.amountEur);
      tiles.replaceChildren(
        tile({ label: 'Net receivables', value: eur0(net), note: `${nf0.format(sum(base, r => r.items))} open items` }),
        tile({ label: 'Past due', value: eur0(overdue), note: owed ? `${nf1.format(overdue / owed * 100)}% of the amounts owed` : '' }),
        tile({ label: 'Not yet due', value: eur0(sum(at(0), r => r.amountEur)), note: `${nf0.format(sum(at(0), r => r.items))} items` }),
        tile({ label: 'Unapplied credit memos', value: eur0(credits), note: `${nf0.format(sum(at(999), r => r.items))} credits, no age` }),
        tile({ label: 'Customers with open items', value: nf0.format(customers) }));
    } else {
      const amt = sum(rows, r => r.amountEur);
      const byCo = COMPANY_ORDER.map(c => [c, sum(rows.filter(r => r.company === c), r => r.amountEur)]).sort((a, b) => b[1] - a[1])[0];
      tiles.replaceChildren(
        tile({ label: bucketNames[sel], value: eur0(amt), note: `${nf0.format(sum(rows, r => r.items))} open items` }),
        tile({ label: 'Share of the amounts owed', value: owed ? nf1.format(amt / owed * 100) + '%' : '*', note: `of ${eur0(owed)}, credit memos left out` }),
        tile({ label: 'Customers in this age band', value: nf0.format(customers) }),
        tile({ label: 'Largest company', value: byCo && byCo[1] > 0 ? shortCo(byCo[0]) : '*', note: byCo && byCo[1] > 0 ? `${eur0(byCo[1])} · ${nf1.format(byCo[1] / amt * 100)}% of this band` : '' }));
    }

    const cos = COMPANY_ORDER.filter(c => rows.some(r => r.company === c));
    const shownBuckets = sel === 'all' ? bucketOrder : [sel];
    const chartRows = cos.map(c => {
      const mine = rows.filter(r => r.company === c);
      const segs = shownBuckets.map(o => {
        const part = mine.filter(r => r.bucketOrder === o);
        const eur = sum(part, r => r.amountEur), local = sum(part, r => r.amount);
        return { key: o, value: eur, tip: [{ value: nf2.format(eur), label: 'EUR' }, { value: nf2.format(local), label: COMP[c].cur + ' (local)' }, { value: nf0.format(sum(part, r => r.items)), label: 'open items' }] };
      });
      return { label: shortCo(c), total: sum(segs, g => g.value), segs };
    });

    const tbl = dataTable([
      { key: 'company', label: 'Company' }, { key: 'bucket', label: 'Debt age' },
      { key: 'items', label: 'Items', num: true, fmt: v => nf0.format(v) },
      { key: 'amount', label: 'Amount (local)', num: true, fmt: v => nf2.format(v) },
      { key: 'currency', label: 'Currency', cls: 'mut' },
      { key: 'amountEur', label: 'Amount (EUR)', num: true, fmt: v => nf2.format(v) },
    ], [...rows].sort((a, b) => a.company.localeCompare(b.company) || a.bucketOrder - b.bucketOrder), { csv: 'cq1_receivables_by_debt_age.csv', pageSize: 100, sort: null });

    // legend: each entry is a button that isolates one age band (click again to see all)
    const legendEl = h('div', { class: 'legend pick' },
      segMeta.map(m => h('button', { type: 'button', class: sel === 'all' ? '' : sel === m.key ? 'on' : 'dim', 'aria-pressed': sel === m.key, title: sel === m.key ? 'Show all ages' : `Show only ${m.label}`, onclick: () => pick(sel === m.key ? 'all' : m.key) },
        h('span', { class: 'sw', style: `background:${m.color}` }), m.label)),
      sel === 'all' ? h('span', { class: 'hint' }, 'Click an age band to see only that one') : h('button', { type: 'button', class: 'link', onclick: () => pick('all') }, 'Show all ages'));

    const draw = w => drawStacked(w, chartRows, segMeta, { axisTitle: 'EUR, converted with the monthly rate of each posting period' });
    const card = chartCard({
      title: sel === 'all' ? 'Receivables by company and debt age' : `Receivables ${sel === 0 ? 'not yet due' : sel === 91 ? 'over 90 days past due' : bucketNames[sel] + ' past due'}, by company`,
      sub: `At ${state.keyDate}, in euros`,
      legendEl, draw, tableEl: tbl,
      footnote: sel === 'all' && credits ? `Unapplied credit memos (${eur0(credits)}) are not part of the bars; they reduce the net receivables above.` : '',
    });
    host.replaceChildren(card.el);

    // customers
    const map = new Map();
    for (const r of rows) {
      const k = r.company + '|' + r.customerNumber;
      if (!map.has(k)) map.set(k, { company: r.company, customerNumber: r.customerNumber, customerName: r.customerName || '(not in the customer master)', customerKind: r.customerKind, currency: r.currency, b0: 0, b1: 0, b31: 0, b61: 0, b91: 0, credits: 0, balanceEur: 0, balanceLocal: 0, items: 0 });
      const c = map.get(k);
      const col = r.bucketOrder === 999 ? 'credits' : 'b' + r.bucketOrder;
      c[col] += r.amountEur; c.balanceEur += r.amountEur; c.balanceLocal += r.amount; c.items += r.items;
    }
    const money = v => (v ? nf2.format(v) : '*');
    const ageCols = [{ key: 'b0', label: 'Not yet due', o: 0 }, { key: 'b1', label: '1–30', o: 1 }, { key: 'b31', label: '31–60', o: 31 },
      { key: 'b61', label: '61–90', o: 61 }, { key: 'b91', label: 'Over 90', o: 91 }]
      .filter(c => sel === 'all' || c.o === sel).map(c => ({ key: c.key, label: c.label, num: true, fmt: money }));
    detail.replaceChildren(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, sel === 'all' ? 'Balance per customer' : `Customers with items ${bucketNames[sel].toLowerCase()}`),
        h('div', { class: 'sub' }, sel === 'all' ? 'One row per customer; the debt-age columns are in euros. * means no amount' : 'One row per customer, only the selected age band'))),
      dataTable([
        { key: 'company', label: 'Co.' }, { key: 'customerNumber', label: 'Customer', cls: 'mut' },
        { key: 'customerName', label: 'Name', cls: 'name' },
        ...ageCols, ...(sel === 'all' ? [{ key: 'credits', label: 'Credits', num: true, fmt: money }] : []),
        { key: 'balanceEur', label: 'Balance (EUR)', num: true, fmt: v => nf2.format(v) },
        { key: 'balanceLocal', label: 'Balance (local)', num: true, fmt: (v, r) => `${nf2.format(v)} ${r.currency}` },
      ], [...map.values()], { sort: 'balanceEur', dir: 'desc', search: ['customerNumber', 'customerName', 'company'], searchLabel: 'Search customers…', csv: 'cq1_receivables_per_customer.csv', pageSize: 25 })));
  }

  await load();
}

// ---------------------------------------------------------------- CQ2
async function viewCQ2(view) {
  const q = Q.cq2;
  const data = await ask(q.text);
  const filters = h('div', { class: 'filters' });
  const tiles = h('div', { class: 'tiles' });
  const host = h('div');
  const fq = foldQuery(() => q.text);
  view.append(pageHead('Competency question 2', q.question,
    'Vendors ranked by the gross amount of their payable invoices in fiscal year 2025, converted to euros. Employees reimbursed through the payables ledger are payees, not vendors, so they do not appear.'),
    filters, tiles, host, foldNotes(q), fq.el);
  filters.append(field('Company', companySelect('company', update)),
    field('Show the top', select([[5, '5'], [10, '10'], [20, '20'], [9999, 'all']], state.topN, v => { state.topN = +v; update(); })));
  const note = h('p', { class: 'sub', style: 'margin:-6px 0 14px' }, 'The company filter and the top-N are applied to the query result; the query itself returns every vendor of every company.');
  filters.after(note);

  function update() {
    const rows = data.rows.filter(r => state.company === 'all' || r.company === state.company).sort((a, b) => b.invoicedEur - a.invoicedEur);
    const total = sum(rows, r => r.invoicedEur);
    const top5 = sum(rows.slice(0, 5), r => r.invoicedEur);
    tiles.replaceChildren(
      tile({ label: 'Invoiced in 2025', value: eur0(total), note: 'gross, tax included' }),
      tile({ label: 'Vendors invoicing', value: nf0.format(new Set(rows.map(r => r.vendorNumber)).size) }),
      tile({ label: 'Payable invoices', value: nf0.format(sum(rows, r => r.invoices)), note: 'reversed invoices excluded' }),
      tile({ label: 'Top 5 vendors', value: total ? nf1.format(top5 / total * 100) + '%' : '*', note: `${eur0(top5)} of the total` }));
    const multi = state.company === 'all';
    const items = rows.slice(0, state.topN).map(r => ({
      label: multi ? `${r.company} · ${r.vendorName}` : r.vendorName, value: r.invoicedEur,
      tip: [{ value: nf2.format(r.invoicedEur), label: 'EUR invoiced' }, { value: nf0.format(r.invoices), label: 'invoices' }, { value: nf1.format(r.invoicedEur / total * 100) + '%', label: 'of the selection' }, { value: r.vendorNumber, label: 'vendor number' }],
    }));
    const tbl = dataTable([
      { key: 'rank', label: '#', num: true, sortable: false }, { key: 'company', label: 'Co.' }, { key: 'vendorNumber', label: 'Vendor', cls: 'mut' },
      { key: 'vendorName', label: 'Name', cls: 'name' }, { key: 'invoices', label: 'Invoices', num: true, fmt: v => nf0.format(v) },
      { key: 'invoicedEur', label: 'Invoiced (EUR)', num: true, fmt: v => nf2.format(v) },
      { key: 'share', label: 'Share', num: true, fmt: v => nf1.format(v) + '%' },
    ], rows.map((r, i) => ({ ...r, rank: i + 1, share: total ? r.invoicedEur / total * 100 : 0 })), { csv: 'cq2_vendor_invoicing.csv', pageSize: 25, sort: 'invoicedEur', dir: 'desc', search: ['vendorName', 'vendorNumber'], searchLabel: 'Search vendors…' });
    const card = chartCard({
      title: `Top ${state.topN >= 9999 ? 'all' : state.topN} vendors by invoiced amount`,
      sub: multi ? 'All companies, ranked together in euros' : `${COMP[state.company].name}`,
      draw: w => drawHBars(w, items, { axisTitle: 'EUR invoiced in 2025' }), tableEl: tbl,
    });
    host.replaceChildren(card.el);
  }
  update();
}

// ---------------------------------------------------------------- CQ3
async function viewCQ3(view) {
  const q = Q.cq3;
  const data = await ask(q.text);
  const filters = h('div', { class: 'filters' });
  const tiles = h('div', { class: 'tiles' });
  const host = h('div');
  const fq = foldQuery(() => q.text);
  view.append(pageHead('Competency question 3', q.question,
    'Cost posted to expense accounts that require a cost centre, in euros. Lines with no cost centre are kept in their own row rather than dropped.'),
    filters, tiles, host, foldNotes(q), fq.el);
  filters.append(field('Company', companySelect('company', update)));

  function update() {
    const rows = data.rows.filter(r => state.company === 'all' || r.company === state.company);
    const typeTotals = new Map();
    for (const r of rows) typeTotals.set(r.expenseType, (typeTotals.get(r.expenseType) || 0) + r.costEur);
    const types = [...typeTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const cc = new Map();
    for (const r of rows) {
      const k = r.company + '|' + r.costCenter;
      if (!cc.has(k)) cc.set(k, { key: k, company: r.company, code: r.costCenter, name: r.costCenterName, lines: 0, byType: new Map(), linesByType: new Map() });
      const o = cc.get(k);
      o.byType.set(r.expenseType, (o.byType.get(r.expenseType) || 0) + r.costEur);
      o.linesByType.set(r.expenseType, (o.linesByType.get(r.expenseType) || 0) + r.lines);
      o.lines += r.lines;
    }
    const multi = state.company === 'all';
    const rowsDef = [...cc.values()]
      .sort((a, b) => a.company.localeCompare(b.company) || (a.code.startsWith('(') - b.code.startsWith('(')) || a.code.localeCompare(b.code))
      .map(o => ({ ...o, label: (multi ? o.company + ' · ' : '') + o.name, muted: o.code.startsWith('(') }));
    const total = sum(rows, r => r.costEur);
    const noCc = sum(rows.filter(r => r.costCenter.startsWith('(')), r => r.costEur);
    const biggest = types[0];
    tiles.replaceChildren(
      tile({ label: 'Cost in the selection', value: eur0(total), note: `${nf0.format(sum(rows, r => r.lines))} posting lines` }),
      tile({ label: 'Cost centres', value: nf0.format([...cc.values()].filter(o => !o.code.startsWith('(')).length) }),
      tile({ label: 'Largest expense type', value: biggest || '*', note: biggest ? `${eur0(typeTotals.get(biggest))} · ${nf1.format(typeTotals.get(biggest) / total * 100)}%` : '' }),
      tile({ label: 'Lines without a cost centre', value: eur0(noCc), note: 'required by the account, missing in the data' }));

    const tbl = dataTable([
      { key: 'company', label: 'Co.' }, { key: 'name', label: 'Cost centre', cls: 'name' },
      ...types.map(t => ({ key: 't_' + t, label: t, num: true, fmt: v => (v ? nf2.format(v) : '*') })),
      { key: 'total', label: 'Total', num: true, fmt: v => nf2.format(v) },
    ], rowsDef.map(o => { const r = { company: o.company, name: o.name, total: sum([...o.byType.values()], x => x) }; for (const t of types) r['t_' + t] = o.byType.get(t) || 0; return r; }), { csv: 'cq3_cost_by_cost_center.csv', pageSize: 40 });

    const card = chartCard({
      title: 'Cost by cost centre and expense type', sub: 'Euros; darker means more cost (square-root scale so small cells stay visible)',
      draw: w => drawHeat(w, rowsDef, types, (r, t) => r.byType.get(t) || 0, { cellTip: (r, t, v) => [{ value: nf2.format(v), label: 'EUR' }, { value: nf0.format(r.linesByType.get(t) || 0), label: 'posting lines' }, { value: t, label: 'expense type' }] }),
      tableEl: tbl,
    });
    host.replaceChildren(card.el);
  }
  update();
}

// ---------------------------------------------------------------- CQ4
async function viewCQ4(view) {
  const q = Q.cq4;
  const data = await ask(q.text);
  const rows = [...data.rows].sort((a, b) => a.netDays - b.netDays);
  const fq = foldQuery(() => q.text);
  const n = sum(rows, r => r.invoicesPaid);
  const avg = sum(rows, r => r.avgDaysToPay * r.invoicesPaid) / n;
  const late = sum(rows, r => r.avgDaysLate * r.invoicesPaid) / n;
  const paidLate = sum(rows, r => r.paidLate);
  const tiles = h('div', { class: 'tiles' },
    tile({ label: 'Invoices paid', value: nf0.format(n), note: 'customer invoices cleared by a payment' }),
    tile({ label: 'Average days to pay', value: nf1.format(avg), unit: 'days' }),
    tile({ label: 'Average days late', value: (late >= 0 ? '+' : '') + nf1.format(late), unit: 'days', note: 'against the agreed terms' }),
    tile({ label: 'Paid after the due date', value: nf1.format(paidLate / n * 100) + '%', note: `${nf0.format(paidLate)} of ${nf0.format(n)} invoices` }));
  const items = rows.map(r => ({
    label: r.termsName, sub: `${nf0.format(r.invoicesPaid)} invoices`, terms: r.netDays, actual: r.avgDaysToPay,
    tip: [{ value: nf0.format(r.netDays) + ' days', label: 'agreed terms' }, { value: nf1.format(r.avgDaysToPay) + ' days', label: 'average to pay' }, { value: (r.avgDaysLate >= 0 ? '+' : '') + nf1.format(r.avgDaysLate) + ' days', label: 'average vs terms' }, { value: nf1.format(r.paidLate / r.invoicesPaid * 100) + '%', label: 'paid late' }],
  }));
  const tbl = dataTable([
    { key: 'paymentTerms', label: 'Code', cls: 'mut' }, { key: 'termsName', label: 'Payment terms' },
    { key: 'netDays', label: 'Agreed (days)', num: true, fmt: v => nf0.format(v) },
    { key: 'invoicesPaid', label: 'Invoices paid', num: true, fmt: v => nf0.format(v) },
    { key: 'avgDaysToPay', label: 'Avg days to pay', num: true, fmt: v => nf1.format(v) },
    { key: 'avgDaysLate', label: 'Avg days late', num: true, fmt: v => (v >= 0 ? '+' : '') + nf1.format(v) },
    { key: 'paidLate', label: 'Paid late', num: true, fmt: v => nf0.format(v) },
    { key: 'pctLate', label: '% late', num: true, fmt: v => nf1.format(v) + '%' },
  ], rows.map(r => ({ ...r, pctLate: r.paidLate / r.invoicesPaid * 100 })), { csv: 'cq4_days_to_pay.csv', sort: 'netDays', dir: 'asc' });
  const card = chartCard({
    title: 'Agreed payment terms against actual days to pay', sub: 'One row per payment-terms code',
    legendEl: legend([{ label: 'Days agreed in the terms', color: C.age[0], type: 'mk' }, { label: 'Average days customers took to pay', color: C.age[3], type: 'mk' }]),
    draw: w => drawDumbbell(w, items), tableEl: tbl,
  });
  const fqx = fq;
  view.append(pageHead('Competency question 4', q.question,
    'For every customer invoice that has been paid, the days between its baseline date and the payment, compared with the net days of its payment terms.'),
    tiles, card.el, foldNotes(q), fqx.el);
}

// ---------------------------------------------------------------- CQ5
async function viewCQ5(view) {
  const q = Q.cq5;
  const data = await ask(q.text);
  const filters = h('div', { class: 'filters' });
  const tiles = h('div', { class: 'tiles' });
  const host = h('div');
  const fq = foldQuery(() => q.text);
  view.append(pageHead('Competency question 5', q.question,
    'Revenue minus expenses for the profit-and-loss accounts, by company and month. The chart uses euros so the three companies share one axis; the table also has local currency.'),
    filters, tiles, host, foldNotes(q), fq.el);
  filters.append(field('Company', companySelect('q5Company', update)));

  function update() {
    const cos = COMPANY_ORDER.filter(c => data.rows.some(r => r.company === c) && (state.q5Company === 'all' || state.q5Company === c));
    const rows = data.rows.filter(r => cos.includes(r.company));
    const series = cos.map(c => ({ id: c, label: shortCo(c), color: coColor(c), values: MONTHS.map((_, i) => { const r = rows.find(x => x.company === c && x.month === i + 1); return r ? r.resultEur : null; }) }));
    const monthly = MONTHS.map((_, i) => sum(series, sr => sr.values[i] || 0));
    const best = monthly.indexOf(Math.max(...monthly)), worst = monthly.indexOf(Math.min(...monthly));
    const total = sum(monthly, x => x);
    tiles.replaceChildren(
      tile({ label: cos.length > 1 ? 'Group result 2025' : 'Result 2025', value: eur0(total), note: cos.length > 1 ? 'sum of the three companies in euros' : `${nf2.format(sum(rows, r => r.result))} ${COMP[cos[0]].cur} in local currency` }),
      ...(cos.length > 1 ? cos.map(c => tile({ label: shortCo(c), value: eur0(sum(rows.filter(r => r.company === c), r => r.resultEur)), note: `${nf2.format(sum(rows.filter(r => r.company === c), r => r.result))} ${COMP[c].cur}` })) : []),
      tile({ label: 'Best month', value: MONTHS[best], note: `${eur0(monthly[best])} · weakest: ${MONTHS[worst]} (${eur0(monthly[worst])})` }));
    const tbl = dataTable([
      { key: 'company', label: 'Co.' }, { key: 'monthName', label: 'Month', sortable: false }, { key: 'currency', label: 'Currency', cls: 'mut' },
      { key: 'revenue', label: 'Revenue (local)', num: true, fmt: v => nf2.format(v) },
      { key: 'expenses', label: 'Expenses (local)', num: true, fmt: v => nf2.format(v) },
      { key: 'result', label: 'Result (local)', num: true, fmt: v => nf2.format(v) },
      { key: 'resultEur', label: 'Result (EUR)', num: true, fmt: v => nf2.format(v) },
    ], rows.map(r => ({ ...r, monthName: MONTHS[r.month - 1] })).sort((a, b) => a.company.localeCompare(b.company) || a.month - b.month), { csv: 'cq5_profit_and_loss.csv', pageSize: 40 });
    const card = chartCard({
      title: 'Monthly result by company', sub: 'Revenue minus expenses, euros',
      legendEl: legend(series.map(sr => ({ label: sr.label, color: sr.color, type: 'ln' }))),
      draw: w => drawLines(w, series, { yTitle: 'EUR' }), tableEl: tbl,
    });
    host.replaceChildren(card.el);
  }
  update();
}

// ---------------------------------------------------------------- Console
const DEFAULT_PREFIXES = `PREFIX nvf:     <https://nordvia.com/ontology/finance#>
PREFIX rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:     <http://www.w3.org/2001/XMLSchema#>
PREFIX skos:    <http://www.w3.org/2004/02/skos/core#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX foaf:    <http://xmlns.com/foaf/0.1/>
PREFIX org:     <http://www.w3.org/ns/org#>
PREFIX rov:     <http://www.w3.org/ns/regorg#>
`;
const EXAMPLES = [
  ['Classes in use', `${DEFAULT_PREFIXES}
SELECT ?class (COUNT(?s) AS ?instances)
WHERE { ?s a ?class }
GROUP BY ?class
ORDER BY DESC(?instances)
LIMIT 25`],
  ['Debt-age buckets in the ontology', `${DEFAULT_PREFIXES}
SELECT ?bucket ?label ?min ?max
WHERE {
  ?bucket a nvf:DebtAgeBucket ; rdfs:label ?label .
  OPTIONAL { ?bucket nvf:minDaysOverdue ?min }
  OPTIONAL { ?bucket nvf:maxDaysOverdue ?max }
}
ORDER BY ?min`],
  ['Monthly exchange rates to euros', `${DEFAULT_PREFIXES}
SELECT ?rate ?label ?value ?documents
WHERE {
  ?rate a nvf:MonthlyExchangeRate ; rdfs:label ?label ; nvf:rate ?value ; nvf:documentsUsed ?documents .
}
ORDER BY ?label`],
  ['Payment terms and tax codes', `${DEFAULT_PREFIXES}
SELECT ?code ?label ?netDays
WHERE {
  ?terms a nvf:PaymentTerms ; skos:notation ?code ; rdfs:label ?label .
  OPTIONAL { ?terms nvf:netDays ?netDays }
}
ORDER BY ?code`],
];

// A SPARQL result as a table (IRIs shortened with the usual prefixes, numbers formatted)
function resultCell(t) {
  if (!t) return h('td', { class: 'mut' }, '');
  if (t.type === 'uri') {
    let short = t.value;
    for (const [ns, p] of Object.entries(PREFIXES)) if (t.value.startsWith(ns)) { short = p + ':' + t.value.slice(ns.length); break; }
    return h('td', { title: t.value }, short);
  }
  const num = /#(integer|int|long|decimal|double|float)$/.test(t.datatype || '');
  return h('td', { class: num ? 'num' : '', title: t.datatype || '' }, num ? nf2.format(Number(t.value)).replace(/\.00$/, '') : t.value);
}
function resultTable(r, max = 500) {
  const shown = r.bindings.slice(0, max);
  return h('div', null,
    h('div', { class: 'tablewrap', style: 'margin-top:14px;max-height:520px;overflow:auto' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, r.vars.map(v => h('th', null, v)))),
      h('tbody', null, shown.map(b => h('tr', null, r.vars.map(v => resultCell(b[v]))))))),
    r.bindings.length > shown.length ? h('div', { class: 'more' }, `Showing the first ${shown.length} of ${nf0.format(r.bindings.length)} rows; the CSV has all of them.`) : null);
}

async function viewConsole(view) {
  const examples = [...EXAMPLES, ...Object.values(Q).sort((a, b) => parseHeader(a.text).no - parseHeader(b.text).no).map(x => [`CQ${parseHeader(x.text).no} · ${parseHeader(x.text).question}`, x.text])];
  const editor = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': 'SPARQL query' });
  editor.value = pendingConsole || examples[0][1];
  pendingConsole = null;
  const out = h('div');
  const statusLine = h('div', { class: 'statusline' });
  const histBox = h('div', { class: 'hist' });
  const history = JSON.parse(sessionStorage.getItem('nvf-history') || '[]');
  const showHistory = () => { histBox.replaceChildren(...history.map(t => h('button', { type: 'button', title: t, onclick: () => { editor.value = t; } }, t.replace(/\s+/g, ' ').replace(/^(PREFIX[^>]*> ?)+/, '')))); };
  showHistory();

  async function run() {
    const text = editor.value;
    statusLine.replaceChildren('Running…');
    out.replaceChildren();
    try {
      const r = await sparql(text);
      history.unshift(text);
      sessionStorage.setItem('nvf-history', JSON.stringify([...new Set(history)].slice(0, 12)));
      history.splice(0, history.length, ...JSON.parse(sessionStorage.getItem('nvf-history')));
      showHistory();
      statusLine.replaceChildren(h('span', null, `${nf0.format(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}`), h('span', null, `${r.ms} ms`),
        h('button', { class: 'btn', type: 'button', onclick: () => downloadCSV('query_result.csv', r.vars, r.rows.map(x => r.vars.map(v => x[v]))) }, 'Export CSV'));
      out.replaceChildren(resultTable(r));
    } catch (e) {
      statusLine.replaceChildren();
      out.replaceChildren(h('div', { class: 'err' }, h('b', null, 'The query failed. '), String(e.message || e)));
    }
  }

  editor.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab') { e.preventDefault(); const p = editor.selectionStart; editor.setRangeText('  ', p, editor.selectionEnd, 'end'); }
  });

  view.append(pageHead('Tools', 'SPARQL console', 'Write any SELECT or ASK query against the graph. The endpoint is read only: updates are rejected.'),
    h('section', { class: 'card' },
      h('div', { class: 'filters' },
        field('Start from an example', select([['', 'Choose…'], ...examples.map((e, i) => [i, e[0]])], '', v => { if (v !== '') editor.value = examples[+v][1]; })),
        h('button', { class: 'btn', type: 'button', onclick: () => { if (!/^\s*PREFIX/i.test(editor.value)) editor.value = DEFAULT_PREFIXES + '\n' + editor.value; } }, 'Add the usual prefixes'),
        h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Run  (Ctrl + Enter)')),
      editor, statusLine, out),
    h('details', { class: 'fold' }, h('summary', null, 'Recent queries'), h('div', { class: 'inner' }, histBox)));
  if (view.dataset.autorun) run();
}

// ---------------------------------------------------------------- Ask the graph (natural language -> SPARQL)
const ASK_EXAMPLES = [
  'Which customers owe us the most, and how overdue is it?',
  'How much did each company spend on vendor invoices in 2025?',
  'Which cost centres carry the highest cost?',
  'Which customer invoices were paid more than 30 days after the due date?',
  'What is the profit of each company in 2025, in euros?',
  '¿Cuánto IVA repercutido y soportado tiene cada sociedad por mes?',
  'Which documents were reversed, and by which document?',
  'How many line items does each document type have?',
];
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'The server answered something unexpected.' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function viewAsk(view) {
  const box = h('textarea', { class: 'editor ask', rows: 3, spellcheck: 'false', placeholder: 'Write a question about the accounting data, in English or Spanish…', 'aria-label': 'Question' });
  const status = h('div', { class: 'statusline' });
  const out = h('div');
  const asked = JSON.parse(sessionStorage.getItem('nvf-asked') || '[]');
  const askedBox = h('div', { class: 'hist' });
  const showAsked = () => askedBox.replaceChildren(...asked.map(t => h('button', { type: 'button', title: t, onclick: () => { box.value = t; box.focus(); } }, t)));
  showAsked();
  let engine = { available: false };
  const engineLine = h('div', { class: 'engine' }, 'Checking Claude Code…');
  fetch('/api/ask/status').then(r => r.json()).then(j => {
    engine = j;
    engineLine.replaceChildren(j.available
      ? h('span', null, h('b', { class: 'ok' }, '● Claude Code ready'), ` · ${j.version} · model: ${j.model}`)
      : h('span', null, h('b', { class: 'warn' }, '● Claude Code not found'), ''));
  }).catch(() => engineLine.replaceChildren('Could not check Claude Code.'));

  // show an answer (a query + explanation) and run it
  async function present(a, question) {
    const parts = [];
    if (a.cannot_answer) parts.push(h('div', { class: 'note warn' }, h('b', null, 'The graph cannot answer this. '), a.cannot_answer, a.explanation ? h('div', { style: 'margin-top:6px' }, a.explanation) : null));
    if (a.explanation && !a.cannot_answer) parts.push(h('p', { class: 'explain' }, a.explanation));
    if (a.repaired) parts.push(h('div', { class: 'note' }, 'The first query failed, so Claude corrected it once. First error: ', h('code', null, String(a.first_error || '').split('\n')[0].slice(0, 90) + '…')));
    (a.warnings || []).forEach(w => parts.push(h('div', { class: 'note warn' }, '⚠ ', w)));
    out.replaceChildren(...parts);
    if (!a.sparql) return;
    let text = a.sparql;
    const fold = foldQuery(() => text, 'The SPARQL query');
    fold.el.open = true;
    out.append(fold.el);
    const resultBox = h('div');
    out.append(resultBox);
    resultBox.replaceChildren('Running the query…');
    try {
      const r = await sparql(text);
      resultBox.replaceChildren(
        h('div', { class: 'statusline' }, h('span', null, `${nf0.format(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}`), h('span', null, `${r.ms} ms`),
          a.seconds ? h('span', null, `written in ${a.seconds} s`) : null,
          h('button', { class: 'btn', type: 'button', onclick: () => downloadCSV('answer.csv', r.vars, r.rows.map(x => r.vars.map(v => x[v]))) }, 'Export CSV')),
        r.rows.length ? resultTable(r) : h('div', { class: 'note' }, 'The query ran but returned no rows. Check the query above: a filter may be too narrow, or the data may not hold what was asked.'));
    } catch (e) {
      resultBox.replaceChildren(h('div', { class: 'err' }, h('b', null, 'The query failed. '), String(e.message || e)));
    }
  }

  async function go() {
    const q = box.value.trim();
    if (!q) return;
    out.replaceChildren(); status.replaceChildren(h('span', { class: 'spin' }), 'Claude is writing the query… (usually 10 to 40 seconds)');
    askBtn.disabled = true;
    try {
      const a = await post('/api/ask', { question: q });
      status.replaceChildren();
      asked.splice(0, asked.length, ...[q, ...asked.filter(x => x !== q)].slice(0, 10));
      sessionStorage.setItem('nvf-asked', JSON.stringify(asked)); showAsked();
      await present(a, q);
    } catch (e) {
      status.replaceChildren();
      out.replaceChildren(h('div', { class: 'err' }, h('b', null, 'Claude could not answer. '), String(e.message || e)));
    } finally { askBtn.disabled = false; }
  }
  const askBtn = h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Ask Claude  (Ctrl + Enter)');
  box.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go(); } });

  view.append(pageHead('Tools', 'Ask the graph', 'Ask in plain language. Claude writes the SPARQL query from the ontology, the query runs on this graph, and you see both the query and the rows it returns.'),
    h('section', { class: 'card' },
      engineLine,
      h('div', { class: 'filters' }, field('Try one of these', select([['', 'Choose…'], ...ASK_EXAMPLES.map((e, i) => [i, e])], '', v => { if (v !== '') { box.value = ASK_EXAMPLES[+v]; box.focus(); } }))),
      box,
      h('div', { class: 'row-actions', style: 'margin-top:10px' }, askBtn),
      status, out),
    h('details', { class: 'fold' }, h('summary', null, 'Earlier questions'), h('div', { class: 'inner' }, askedBox)));
  box.focus();
}

// ---------------------------------------------------------------- Ontology graph (overview)
const NVF = 'https://nordvia.com/ontology/finance#';
const FIBO_CUR = 'https://spec.edmcouncil.org/fibo/ontology/FND/Accounting/CurrencyAmount/Currency';
const ONTO_PFX = `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX nvf: <${NVF}>
`;
// Where each class sits in the picture: groups are the seven domains of the model, rows are the
// levels of the class hierarchy. Classes that are not listed here are added in a last group.
const ONTO_COLS = [
  [
    ['Organization', [['Company', 'ControllingArea'], ['CostCenter', 'CostCenterCategory']]],
    ['Currency and exchange rates', [['MonthlyExchangeRate', 'RateDerivationMethod'], [FIBO_CUR]]],
    ['Business partners', [['BusinessPartner'], ['Customer', 'Payee'], ['DomesticCustomer', 'ForeignCustomer', 'OneTimeCustomer', 'UnregisteredCustomer'], ['Vendor', 'Employee']]],
  ],
  [
    ['Accounting documents', [['AccountingDocument', 'DocumentType'], ['Invoice', 'CustomerCreditMemo', 'CustomerPayment', 'OutgoingPayment', 'GLDocument'], ['CustomerInvoice', 'PayableInvoice', 'ReversalDocument', 'ReversedDocument', 'OpeningBalanceDocument']]],
    ['Postings', [['LineItem', 'PostingKey', 'DebitCreditIndicator'], ['DebitLineItem', 'CreditLineItem', 'PaymentTerms'], ['TaxCode', 'DebtAgeBucket'], ['InputTaxCode', 'OutputTaxCode']]],
  ],
  [
    ['Accounts', [['GLAccount', 'AccountType', 'ChartOfAccounts'], ['BalanceSheetAccount', 'ProfitAndLossAccount'], ['CompanyAccount', 'CostCenterRequiredAccount'], ['ReconciliationAccount'], ['ReceivablesAccount', 'PayablesAccount']]],
  ],
];
// Defined classes (owl:equivalentClass) are recognised from data, so the ontology file does not
// assert their place in the hierarchy; the picture draws it from their definitions.
const ONTO_EXTRA_SUB = [['DebitLineItem', 'LineItem'], ['CreditLineItem', 'LineItem'], ['ReversedDocument', 'AccountingDocument'], ['CostCenterRequiredAccount', 'CompanyAccount']];

async function ontologyCard() {
  const local = iri => iri.startsWith(NVF) ? iri.slice(NVF.length) : iri;
  const [cls, sub, ops, dps, uses, counts] = await Promise.all([
    ask(ONTO_PFX + `SELECT ?c ?label ?def ?note ?src (EXISTS { ?c owl:equivalentClass ?e } AS ?defined) (EXISTS { ?c rdfs:subClassOf skos:Concept } AS ?codelist) WHERE {
      { ?c a owl:Class FILTER(STRSTARTS(STR(?c), "${NVF}")) } UNION { VALUES ?c { <${FIBO_CUR}> } }
      OPTIONAL { ?c rdfs:label ?label } OPTIONAL { ?c skos:definition ?def } OPTIONAL { ?c skos:scopeNote ?note } OPTIONAL { ?c nvf:sourceField ?src } }`),
    ask(ONTO_PFX + `SELECT ?c ?s WHERE { ?c rdfs:subClassOf ?s FILTER(STRSTARTS(STR(?c), "${NVF}") && STRSTARTS(STR(?s), "${NVF}")) }`),
    ask(ONTO_PFX + `SELECT ?p ?label ?d ?r ?inv WHERE { ?p a owl:ObjectProperty OPTIONAL { ?p rdfs:label ?label } OPTIONAL { ?p rdfs:domain ?d } OPTIONAL { ?p rdfs:range ?r } OPTIONAL { ?p owl:inverseOf ?inv } }`),
    ask(ONTO_PFX + `SELECT ?p ?d ?r WHERE { ?p a owl:DatatypeProperty OPTIONAL { ?p rdfs:domain ?d } OPTIONAL { ?p rdfs:range ?r } FILTER(STRSTARTS(STR(?p), "${NVF}")) }`),
    ask(ONTO_PFX + `SELECT ?p ?dc ?rc WHERE { { SELECT DISTINCT ?p ?dc ?rc WHERE { ?p a owl:ObjectProperty . ?x ?p ?y . ?x a ?dc . ?y a ?rc } } }`),
    ask(`SELECT ?c (COUNT(?x) AS ?n) WHERE { ?x a ?c } GROUP BY ?c`),
  ]);

  // ---- model
  const nodes = new Map();
  for (const r of cls.rows) {
    const id = r.c, short = id === FIBO_CUR ? 'Currency' : local(id);
    nodes.set(id, { id, short, label: id === FIBO_CUR ? 'Currency' : (r.label || short.replace(/([a-z])([A-Z])/g, '$1 $2')), def: r.def, note: r.note, src: r.src, defined: r.defined === 'true', codelist: r.codelist === 'true', external: id === FIBO_CUR, count: 0, dprops: [], out: [], inn: [], supers: [], subs: [] });
  }
  for (const r of counts.rows) if (nodes.has(r.c)) nodes.get(r.c).count = r.n;
  const subEdges = [];
  const addSub = (c, s2) => { if (nodes.has(c) && nodes.has(s2) && !subEdges.some(e => e[0] === c && e[1] === s2)) { subEdges.push([c, s2]); nodes.get(c).supers.push(s2); nodes.get(s2).subs.push(c); } };
  sub.rows.forEach(r => addSub(r.c, r.s));
  ONTO_EXTRA_SUB.forEach(([c, s2]) => addSub(NVF + c, NVF + s2));
  const ancestors = id => { const seen = new Set(), stack = [id]; while (stack.length) for (const p of nodes.get(stack.pop())?.supers || []) if (!seen.has(p)) { seen.add(p); stack.push(p); } return seen; };
  for (const r of dps.rows) { const n = nodes.get(r.d); if (n) n.dprops.push({ name: local(r.p), range: (r.r || '').replace('http://www.w3.org/2001/XMLSchema#', 'xsd:') }); }

  // object properties: declared domain and range when there are both; otherwise the classes the data actually links, kept at the most general level
  const inverseOf = new Set(ops.rows.filter(r => r.inv).map(r => r.p));
  const edges = [];
  const byProp = new Map();
  ops.rows.forEach(r => { if (!byProp.has(r.p)) byProp.set(r.p, r); });
  for (const [p, r] of byProp) {
    if (inverseOf.has(p)) continue;
    let pairs = [];
    if (r.d && r.r) pairs = [[r.d, r.r]];
    else {
      const found = uses.rows.filter(u => u.p === p && nodes.has(u.dc) && nodes.has(u.rc) && (!r.d || u.dc === r.d) && (!r.r || u.rc === r.r)).map(u => [u.dc, u.rc]);
      const keepGeneral = (list, side) => list.filter(a => !list.some(b => b[side] !== a[side] && ancestors(a[side]).has(b[side])));
      pairs = keepGeneral(keepGeneral(found, 0), 1);
      const seen = new Set(); pairs = pairs.filter(x => { const k = x.join(); return seen.has(k) ? false : (seen.add(k), true); });
    }
    for (const [d, rg] of pairs) {
      if (!nodes.has(d) || !nodes.has(rg) || d === rg) continue;
      const e = { p, name: r.label || local(p).replace(/^.*[#/]/, ''), from: d, to: rg, inverse: [...byProp.values()].find(x => x.inv === p)?.p };
      edges.push(e); nodes.get(d).out.push(e); nodes.get(rg).inn.push(e);
    }
  }

  // ---- layout
  const W = 'Segoe UI, system-ui, sans-serif', NH = 34, GX = 16, GY = 46, PAD = 18, HEAD = 34;
  const measure = t => Math.round(t.length * 7.6 + 30);
  const placed = new Set(), groups = [];
  const byShort = new Map([...nodes.values()].map(n => [n.short === 'Currency' ? FIBO_CUR : n.short, n]));
  let colX = 0, maxY = 0;
  const chunk = (r, n) => r.length <= n ? [r] : [r.slice(0, n), ...chunk(r.slice(n), n)];   // rows of at most three classes, so the picture stays compact
  const cols = ONTO_COLS.map(c => c.map(([t, rows]) => [t, rows.map(r => r.filter(k => byShort.has(k))).flatMap(r => chunk(r, 3))]));
  const rest = [...nodes.values()].filter(n => !cols.flat().some(([, rows]) => rows.flat().includes(n.short === 'Currency' ? FIBO_CUR : n.short)));
  if (rest.length) cols[cols.length - 1].push(['Other classes', [rest.map(n => n.short)]]);
  for (const col of cols) {
    let y = 0, colW = 0;
    for (const [title, rows] of col) {
      const rw = rows.map(r => r.reduce((a, k) => a + measure(byShort.get(k).label) + GX, -GX));
      const gw = Math.max(...rw, measure(title) + 40) + PAD * 2;
      const g = { title, x: colX, y, w: gw, h: HEAD + rows.length * (NH + GY) - GY + PAD * 2 };
      rows.forEach((r, i) => { let x = g.x + PAD + (gw - PAD * 2 - rw[i]) / 2; r.forEach(k => { const n = byShort.get(k); n.w = measure(n.label); n.h = NH; n.x0 = x; n.y0 = g.y + HEAD + PAD + i * (NH + GY); n.x = n.x0; n.y = n.y0; n.group = title; x += n.w + GX; placed.add(n); }); });
      groups.push(g); y += g.h + 56; colW = Math.max(colW, gw);
    }
    // columns sit side by side; narrower columns are centred vertically against the tallest one
    col.forEach(([t]) => { const g = groups.find(q => q.title === t); g.col = colX; });
    maxY = Math.max(maxY, y - 56); colX += colW + 110;
  }
  const totalW = colX - 110;
  // centre each column vertically
  for (const col of cols) { const gs = col.map(([t]) => groups.find(q => q.title === t)); const colH = gs[gs.length - 1].y + gs[gs.length - 1].h; const dy = (maxY - colH) / 2; if (dy > 1) gs.forEach(g => { g.y += dy; [...nodes.values()].filter(n => n.group === g.title).forEach(n => { n.y0 += dy; n.y = n.y0; }); }); }
  // widen groups of a column to the widest one, so the boxes line up
  for (const col of cols) { const gs = col.map(([t]) => groups.find(q => q.title === t)); const w = Math.max(...gs.map(g => g.w)); gs.forEach(g => { const dx = (w - g.w) / 2; g.w = w; [...nodes.values()].filter(n => n.group === g.title).forEach(n => { n.x0 += dx; n.x = n.x0; }); }); }

  // ---- drawing
  const view = { x: -20, y: -20, w: totalW + 40, h: maxY + 40 }, home = { ...view };
  const svg = s('svg', { class: 'ograph', style: `aspect-ratio:${view.w}/${view.h}`, viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`, preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': 'Classes of the ontology and the properties that link them' });
  svg.append(s('defs', null,
    s('marker', { id: 'oarr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,1 L9,5 L0,9 z', fill: C.blue })),
    s('marker', { id: 'osub', viewBox: '0 0 12 12', refX: 11, refY: 6, markerWidth: 9, markerHeight: 9, orient: 'auto' }, s('path', { d: 'M1,1 L11,6 L1,11 z', fill: '#fff', stroke: C.muted, 'stroke-width': 1.3 }))));
  const gLayer = s('g'), eLayer = s('g'), nLayer = s('g');
  svg.append(gLayer, eLayer, nLayer);
  groups.forEach(g => { gLayer.append(s('rect', { class: 'og-box', x: g.x, y: g.y, width: g.w, height: g.h, rx: 12 }), s('text', { class: 'og-title', x: g.x + PAD, y: g.y + 21 }, g.title)); g.titleEl = gLayer.lastChild; g.boxEl = gLayer.lastChild.previousSibling; });

  const clip = (n, tx, ty) => { const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = tx - cx, dy = ty - cy; if (!dx && !dy) return [cx, cy]; const k = Math.min((n.w / 2 + 2) / Math.abs(dx || 1e-9), (n.h / 2 + 2) / Math.abs(dy || 1e-9)); return [cx + dx * k, cy + dy * k]; };
  const items = [];
  const pairKey = (a, b) => [a, b].sort().join('|'), seenPair = new Map();
  const allEdges = [
    ...subEdges.map(([c, p2]) => ({ kind: 'sub', from: c, to: p2 })),
    ...edges.map(e => ({ kind: 'prop', ...e })),
  ];
  for (const e of allEdges) {
    const k = pairKey(e.from, e.to) + e.kind; const idx = seenPair.get(k) || 0; seenPair.set(k, idx + 1); e.idx = idx;
    e.path = s('path', { class: 'oe ' + e.kind, fill: 'none', 'marker-end': e.kind === 'sub' ? 'url(#osub)' : 'url(#oarr)' });
    e.hit = s('path', { class: 'oe-hit', fill: 'none' });
    eLayer.append(e.path, e.hit);
    if (e.kind === 'prop') {
      e.halo = s('text', { class: 'elab halo', 'text-anchor': 'middle' }, e.name); e.text = s('text', { class: 'elab', 'text-anchor': 'middle' }, e.name);
      eLayer.append(e.halo, e.text);
    }
  }
  const drawEdge = e => {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
    const bend = e.kind === 'prop' ? (e.idx % 2 ? -1 : 1) * Math.ceil(e.idx / 2) * 26 : 0;
    const mx = (ac[0] + bc[0]) / 2, my = (ac[1] + bc[1]) / 2, dx = bc[0] - ac[0], dy = bc[1] - ac[1], len = Math.hypot(dx, dy) || 1;
    const curve = e.kind === 'prop' ? Math.min(60, len * 0.14) + bend : 0;
    const cx = mx - dy / len * curve, cy = my + dx / len * curve;
    const p0 = clip(a, cx, cy), p1 = clip(b, cx, cy);
    const d = curve ? `M${p0[0]},${p0[1]} Q${cx},${cy} ${p1[0]},${p1[1]}` : `M${p0[0]},${p0[1]} L${p1[0]},${p1[1]}`;
    e.path.setAttribute('d', d); e.hit.setAttribute('d', d);
    if (e.text) { const lx = 0.25 * p0[0] + 0.5 * cx + 0.25 * p1[0], ly = 0.25 * p0[1] + 0.5 * cy + 0.25 * p1[1] - 4; [e.halo, e.text].forEach(t => { t.setAttribute('x', lx); t.setAttribute('y', ly); }); }
  };
  const drawNode = n => n.el.setAttribute('transform', `translate(${n.x},${n.y})`);
  for (const n of nodes.values()) {
    if (!placed.has(n)) continue;
    n.el = s('g', { class: 'on' + (n.defined ? ' defined' : '') + (n.codelist ? ' codelist' : '') + (n.external ? ' external' : ''), tabindex: 0, role: 'button', 'aria-label': n.label });
    n.el.append(s('rect', { class: 'b', width: n.w, height: n.h, rx: 7 }), s('text', { x: n.w / 2, y: n.h / 2 + 4.2, 'text-anchor': 'middle' }, n.label));
    nLayer.append(n.el);
  }
  const live = allEdges.filter(e => nodes.get(e.from)?.el && nodes.get(e.to)?.el);
  allEdges.filter(e => !live.includes(e)).forEach(e => [e.path, e.hit, e.halo, e.text].forEach(x => x?.remove()));
  const redraw = () => { live.forEach(drawEdge); [...nodes.values()].forEach(n => n.el && drawNode(n)); };
  redraw();

  // ---- inspector
  const insp = h('div', { class: 'oinsp' });
  const showInfo = n => {
    if (!n) { insp.hidden = true; insp.replaceChildren(h('div', { class: 'oi-empty' }, h('b', null, 'Select a class'), h('p', null, 'Click a class to see its definition, where it comes from in SAP, its data properties and the links to other classes. Hover to follow a class’s neighbours; drag to move; scroll to zoom.'))); return; }
    const link = id => h('a', { href: '#', onclick: ev => { ev.preventDefault(); choose(id); } }, nodes.get(id).label);
    const sec = (t, kids) => kids.length ? h('div', { class: 'oi-sec' }, h('h4', null, t), ...kids) : null;
    insp.replaceChildren(...[
      h('h3', null, n.label), h('div', { class: 'oi-iri' }, n.external ? 'fibo:Currency (reused)' : 'nvf:' + n.short),
      h('div', { class: 'oi-tags' }, n.defined ? h('span', null, 'defined class') : null, n.codelist ? h('span', null, 'code list') : null, n.external ? h('span', null, 'FIBO') : null, n.src ? h('span', null, 'SAP ' + n.src) : null),
      n.def ? h('p', null, n.def) : null, n.note ? h('p', { class: 'oi-note' }, n.note) : null,
      h('div', { class: 'oi-count' }, h('b', null, nf0.format(n.count)), ' instances in the graph', n.count === 0 && n.subs.length ? ' (its subclasses carry them)' : ''),
      sec('Subclass of', n.supers.map(link)),
      sec('Subclasses', n.subs.map(id => h('div', null, link(id)))),
      sec('Links to other classes', [...n.out.map(e => h('div', { class: 'oi-row' }, h('code', null, e.name), ' → ', link(e.to))), ...n.inn.map(e => h('div', { class: 'oi-row' }, link(e.from), ' → ', h('code', null, e.name)))]),
      sec('Data properties', n.dprops.map(p => h('div', { class: 'oi-row' }, h('code', null, p.name), p.range ? h('span', { class: 'oi-r' }, p.range) : null))),
      h('div', { class: 'row-actions', style: 'margin-top:12px' }, h('button', { class: 'btn', type: 'button', onclick: () => { pendingConsole = `PREFIX nvf: <${NVF}>\nPREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n\nSELECT ?s ?p ?o WHERE {\n  ?s a <${n.id}> ; ?p ?o .\n}\nLIMIT 50`; location.hash = '#/console'; } }, 'Show instances in the console'))].filter(Boolean));
    insp.hidden = false;
  };
  let selected = null;
  const neighbours = n => { const set = new Set([n.id]); live.forEach(e => { if (e.from === n.id) set.add(e.to); if (e.to === n.id) set.add(e.from); }); return set; };
  const mark = n => {
    svg.classList.toggle('focus', !!n);
    if (!n) { nodes.forEach(x => x.el?.classList.remove('hot', 'dim')); live.forEach(e => [e.path, e.halo, e.text].forEach(t => t?.classList.remove('hot', 'dim'))); return; }
    const nb = neighbours(n);
    nodes.forEach(x => x.el?.classList.toggle('hot', x.id === n.id));
    nodes.forEach(x => x.el?.classList.toggle('dim', !nb.has(x.id)));
    live.forEach(e => { const on = e.from === n.id || e.to === n.id; [e.path, e.halo, e.text].forEach(t => { t?.classList.toggle('hot', on); t?.classList.toggle('dim', !on); }); });
  };
  const choose = id => { selected = id ? nodes.get(id) : null; nodes.forEach(x => x.el?.classList.toggle('sel', x === selected)); mark(selected); showInfo(selected); };
  showInfo(null);

  // ---- interaction: hover, select, drag, pan, zoom
  let drag = null, pan = null, moved = false;
  const toSvg = ev => { const r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height); return [view.x + (ev.clientX - r.left) * k, view.y + (ev.clientY - r.top) * k, k]; };
  const setView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  for (const n of nodes.values()) {
    if (!n.el) continue;
    n.el.addEventListener('pointerenter', () => { if (!selected && !drag) mark(n); });
    n.el.addEventListener('pointerleave', () => { if (!selected && !drag) mark(null); });
    n.el.addEventListener('pointerdown', ev => { ev.stopPropagation(); const p = toSvg(ev); drag = { n, dx: p[0] - n.x, dy: p[1] - n.y, sx: ev.clientX, sy: ev.clientY }; moved = false; n.el.setPointerCapture(ev.pointerId); });
    n.el.addEventListener('pointermove', ev => { if (!drag || drag.n !== n) return; if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) > 4) moved = true; if (!moved) return; const p = toSvg(ev); n.x = p[0] - drag.dx; n.y = p[1] - drag.dy; redraw(); });
    n.el.addEventListener('pointerup', ev => { if (drag && drag.n === n) { if (!moved) choose(selected === n ? null : n.id); drag = null; } });
    n.el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(selected === n ? null : n.id); } });
  }
  live.forEach(e => { if (e.kind !== 'prop') return; e.hit.addEventListener('pointerenter', ev => showTip(ev, e.name, [{ value: nodes.get(e.from).label, label: 'from' }, { value: nodes.get(e.to).label, label: 'to' }, ...(e.inverse ? [{ value: local(e.inverse), label: 'inverse' }] : [])])); e.hit.addEventListener('pointermove', moveTip); e.hit.addEventListener('pointerleave', hideTip); });
  svg.addEventListener('pointerdown', ev => { if (ev.target !== svg && !ev.target.classList.contains('og-box')) return; pan = { sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false }; svg.setPointerCapture(ev.pointerId); svg.classList.add('panning'); });
  svg.addEventListener('pointermove', ev => { if (!pan) return; const r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height); if (Math.hypot(ev.clientX - pan.sx, ev.clientY - pan.sy) > 3) pan.moved = true; view.x = pan.vx - (ev.clientX - pan.sx) * k; view.y = pan.vy - (ev.clientY - pan.sy) * k; setView(); });
  svg.addEventListener('pointerup', () => { if (pan && !pan.moved) choose(null); pan = null; svg.classList.remove('panning'); });
  const zoom = (f, cx, cy) => { const nw = Math.min(home.w * 2, Math.max(home.w / 5, view.w * f)), k = nw / view.w; view.x = cx - (cx - view.x) * k; view.y = cy - (cy - view.y) * k; view.w = nw; view.h *= k; setView(); };
  svg.addEventListener('wheel', ev => { ev.preventDefault(); const p = toSvg(ev); zoom(ev.deltaY > 0 ? 1.12 : 1 / 1.12, p[0], p[1]); }, { passive: false });
  const reset = () => { nodes.forEach(n => { n.x = n.x0; n.y = n.y0; }); Object.assign(view, home); setView(); redraw(); };
  const closeBtn = h('button', { class: 'oclose', type: 'button', title: 'Close', onclick: () => choose(null) }, '×');
  const showSub = h('input', { type: 'checkbox', checked: true, onchange: e => svg.classList.toggle('nosub', !e.target.checked) });
  const showLab = h('input', { type: 'checkbox', checked: true, onchange: e => svg.classList.toggle('nolab', !e.target.checked) });

  const tools = h('div', { class: 'gzoom' },
    h('button', { type: 'button', title: 'Zoom in', onclick: () => zoom(1 / 1.25, view.x + view.w / 2, view.y + view.h / 2) }, '+'),
    h('button', { type: 'button', title: 'Zoom out', onclick: () => zoom(1.25, view.x + view.w / 2, view.y + view.h / 2) }, '−'),
    h('button', { type: 'button', class: 'wide', onclick: reset }, 'Reset layout'));
  const key = h('div', { class: 'legend' },
    h('span', null, h('span', { class: 'ksw plain' }), 'class'), h('span', null, h('span', { class: 'ksw list' }), 'code list'), h('span', null, h('span', { class: 'ksw def' }), 'defined class (equivalentClass)'),
    h('span', null, h('span', { class: 'ln', style: `background:${C.blue}` }), 'object property'), h('span', null, h('span', { class: 'ln dash' }), 'subclass of'),
    h('label', { class: 'tog' }, showSub, 'subclass links'), h('label', { class: 'tog' }, showLab, 'property names'));
  return h('section', { class: 'card ocard' },
    h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'sub' }, `${nodes.size - 1} classes of the model plus the reused FIBO currency · ${live.filter(e => e.kind === 'prop').length} object properties drawn · click a class for details, drag to move, scroll to zoom`))),
    key, h('div', { class: 'ograph-wrap' }, svg, tools, h('div', { class: 'oside' }, closeBtn, insp)));
}

// ---------------------------------------------------------------- Home
async function viewOntology(view) {
  view.append(pageHead('Explore', 'Ontology map', 'The classes of the Nordvia finance ontology, grouped in the seven domains of the model, with the subclass hierarchy and the object properties that link them.'));
  const box = h('div', null, h('div', { class: 'note' }, 'Drawing the ontology…'));
  view.append(box);
  try { box.replaceWith(await ontologyCard()); }
  catch (e) { box.replaceChildren(h('div', { class: 'err' }, h('b', null, 'The ontology map could not be drawn. '), String(e.message || e))); console.error(e); }
}

async function viewHome(view) {
  const tiles = {
    cq1: tile({ q: 'Q1', label: 'Net receivables', value: '…', href: '#/cq1' }),
    cq2: tile({ q: 'Q2', label: 'Vendor invoicing in 2025', value: '…', href: '#/cq2' }),
    cq3: tile({ q: 'Q3', label: 'Cost on cost centres', value: '…', href: '#/cq3' }),
    cq4: tile({ q: 'Q4', label: 'Invoices paid after the due date', value: '…', href: '#/cq4' }),
    cq5: tile({ q: 'Q5', label: 'Group result 2025', value: '…', href: '#/cq5' }),
  };
  const tilesRow = h('div', { class: 'tiles' }, Object.values(tiles));
  const facts = h('div', { class: 'facts' });
  view.append(pageHead('Overview', 'Nordvia finance knowledge graph',
    'SAP financial accounting data of three Nordvia Retail companies (Spain, United States, United Kingdom) for fiscal year 2025, modelled as an ontology and queried with SPARQL. Each number below comes from one of the five competency queries.'),
    tilesRow,
    h('section', { class: 'card' }, h('h2', null, 'From SAP tables to answers'),
      h('div', { class: 'flow' }, ['11 SAP tables (CSV)', 'silver: typed and flagged', 'gold: one table per class', 'mappings (YARRRML)', 'RDF graph', 'SPARQL queries'].flatMap((t, i) => [i ? h('em', null, '→') : null, h('span', null, t)])),
      h('p', { class: 'sub', style: 'margin:12px 0 0' }, 'The ontology reuses ROV, ORG, SKOS, FOAF, DCMI Terms and schema.org and links to FIBO; the queries in this explorer are the same files that sit in the queries folder.')),
    h('section', { class: 'card' }, h('h2', { style: 'margin-bottom:10px' }, 'What is in the graph'), facts),
    h('section', { class: 'card octa' }, h('div', null, h('h2', null, 'The ontology'), h('p', { class: 'sub', style: 'margin:4px 0 0' }, 'Classes, subclass links and the properties that connect them, as an interactive map you can move around.')),
      h('a', { class: 'btn primary', href: '#/ontology' }, 'Open the ontology map →')));

  const counts = `PREFIX nvf: <https://nordvia.com/ontology/finance#>
SELECT ?documents ?lines ?customers ?vendors ?employees ?costCenters ?accounts ?rates WHERE {
  { SELECT (COUNT(*) AS ?documents) WHERE { ?x a nvf:AccountingDocument } }
  { SELECT (COUNT(*) AS ?lines) WHERE { ?x a nvf:LineItem } }
  { SELECT (COUNT(*) AS ?customers) WHERE { ?x a nvf:Customer } }
  { SELECT (COUNT(*) AS ?vendors) WHERE { ?x a nvf:Vendor } }
  { SELECT (COUNT(*) AS ?employees) WHERE { ?x a nvf:Employee } }
  { SELECT (COUNT(*) AS ?costCenters) WHERE { ?x a nvf:CostCenter } }
  { SELECT (COUNT(*) AS ?accounts) WHERE { ?x a nvf:GLAccount } }
  { SELECT (COUNT(*) AS ?rates) WHERE { ?x a nvf:MonthlyExchangeRate } }
}`;
  ask(counts).then(r => {
    const c = r.rows[0], info = window.__info || {};
    const items = [['RDF triples', info.triples], ['Accounting documents', c.documents], ['Line items', c.lines], ['Customers', c.customers], ['Vendors', c.vendors], ['Employees paid as payees', c.employees], ['G/L accounts', c.accounts], ['Cost centres', c.costCenters], ['Monthly exchange rates', c.rates]];
    facts.replaceChildren(...items.map(([l, v]) => h('div', null, h('span', null, l), h('b', null, v == null ? '*' : nf0.format(v)))));
  }).catch(() => {});

  const swap = (id, t) => { tiles[id].replaceWith(t); tiles[id] = t; };
  ask(withKeyDate(Q.cq1.text, state.keyDate)).then(r => {
    const net = sum(r.rows, x => x.amountEur);
    const owed = sum(r.rows.filter(x => x.bucketOrder < 999), x => x.amountEur);
    const over = sum(r.rows.filter(x => x.bucketOrder >= 1 && x.bucketOrder < 999), x => x.amountEur);
    swap('cq1', tile({ q: 'Q1', label: 'Net receivables at 31 Dec 2025', value: eur0(net), note: `${nf1.format(over / owed * 100)}% of the amounts owed are past due`, href: '#/cq1' }));
  });
  ask(Q.cq2.text).then(r => {
    swap('cq2', tile({ q: 'Q2', label: 'Vendor invoicing in 2025', value: eur0(sum(r.rows, x => x.invoicedEur)), note: `${nf0.format(sum(r.rows, x => x.invoices))} invoices · ${new Set(r.rows.map(x => x.vendorNumber)).size} vendors`, href: '#/cq2' }));
  });
  ask(Q.cq3.text).then(r => {
    swap('cq3', tile({ q: 'Q3', label: 'Cost on cost centres', value: eur0(sum(r.rows, x => x.costEur)), note: `${new Set(r.rows.filter(x => !x.costCenter.startsWith('(')).map(x => x.company + x.costCenter)).size} cost centres`, href: '#/cq3' }));
  });
  ask(Q.cq4.text).then(r => {
    const n = sum(r.rows, x => x.invoicesPaid), late = sum(r.rows, x => x.paidLate), days = sum(r.rows, x => x.avgDaysLate * x.invoicesPaid) / n;
    swap('cq4', tile({ q: 'Q4', label: 'Invoices paid after the due date', value: nf1.format(late / n * 100) + '%', note: `${days >= 0 ? '+' : ''}${nf1.format(days)} days against the terms, on average`, href: '#/cq4' }));
  });
  ask(Q.cq5.text).then(r => {
    swap('cq5', tile({ q: 'Q5', label: 'Group result 2025', value: eur0(sum(r.rows, x => x.resultEur)), note: 'revenue minus expenses, three companies', href: '#/cq5' }));
  });
}

// ================================================================= router
const ROUTES = [
  { id: 'home', label: 'Overview', group: 'Explore', badge: '⌂', crumb: 'Overview', fn: viewHome },
  { id: 'ontology', label: 'Ontology map', group: 'Explore', badge: '◇', fn: viewOntology },
  { id: 'cq1', label: 'Receivables by age', group: 'Competency questions', badge: 'Q1', fn: viewCQ1 },
  { id: 'cq2', label: 'Vendor invoicing', group: 'Competency questions', badge: 'Q2', fn: viewCQ2 },
  { id: 'cq3', label: 'Cost by cost centre', group: 'Competency questions', badge: 'Q3', fn: viewCQ3 },
  { id: 'cq4', label: 'Days to pay', group: 'Competency questions', badge: 'Q4', fn: viewCQ4 },
  { id: 'cq5', label: 'Profit and loss', group: 'Competency questions', badge: 'Q5', fn: viewCQ5 },
  { id: 'ask', label: 'Ask the graph', group: 'Tools', badge: '✦', fn: viewAsk },
  { id: 'console', label: 'SPARQL console', group: 'Tools', badge: '</>', fn: viewConsole },
];

function buildNav() {
  const nav = $('#nav');
  const groups = [...new Set(ROUTES.map(r => r.group))];
  nav.replaceChildren(...groups.map(g => h('div', { style: 'margin-bottom:16px' }, h('h6', null, g),
    ROUTES.filter(r => r.group === g).map(r => h('a', { href: '#/' + r.id, 'data-id': r.id }, h('i', null, r.badge), r.label)))));
}

async function route() {
  cleanups.forEach(f => f()); cleanups = []; hideTip();
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'home';
  const r = ROUTES.find(x => x.id === id) || ROUTES[0];
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.id === r.id));
  $('#crumb').textContent = r.group === 'Explore' ? r.label : `${r.group} / ${r.label}`;
  const view = $('#view');
  view.replaceChildren();
  window.scrollTo(0, 0);
  try { await r.fn(view); } catch (e) { view.append(h('div', { class: 'err' }, h('b', null, 'Something went wrong. '), String(e.message || e))); console.error(e); }
}

async function boot() {
  buildNav();
  const status = $('#status');
  try {
    const [qs, info] = await Promise.all([fetch('/api/queries').then(r => r.json()), fetch('/api/info').then(r => r.json())]);
    for (const x of qs) Q[x.id.split('_')[0]] = { ...x, ...parseHeader(x.text) };
    window.__info = info;
    const co = await sparql(`PREFIX nvf: <https://nordvia.com/ontology/finance#> PREFIX dcterms: <http://purl.org/dc/terms/> PREFIX rov: <http://www.w3.org/ns/regorg#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?id ?name ?cur WHERE { ?c dcterms:identifier ?id ; rov:legalName ?name ; nvf:localCurrency/skos:notation ?cur }`);
    for (const r of co.rows) COMP[r.id] = { name: r.name, cur: r.cur };
    status.replaceChildren(h('span', { class: 'dot ok' }), h('span', null, `Connected · ${nf0.format(info.triples)} triples`));
  } catch (e) {
    status.replaceChildren(h('span', { class: 'dot bad' }), h('span', null, 'Not connected — start the server with python app/serve.py'));
    $('#view').append(h('div', { class: 'err' }, String(e)));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}
boot();
