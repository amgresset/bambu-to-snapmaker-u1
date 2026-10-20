// Client side: read the uploaded project with JSZip for the previews (filaments, plates, thumbnails).
// Server side: /api/suggest-profile + /api/convert do the conversion and return the change report.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lum = hex => { const h = String(hex || '#888888').replace('#', '').slice(0, 6).padEnd(6, '0'); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); return 0.299 * r + 0.587 * g + 0.114 * b; };
const fg = hex => lum(hex) > 0.55 ? '#111' : '#fff';
const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
const fmt = v => Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));

let profiles = [];
let current = null;   // { file, analysis, result }

// ---------- client-side analysis of the source 3mf
function paintStates(s, out) {
  const ns = []; for (let i = s.length - 1; i >= 0; i--) ns.push(parseInt(s[i], 16));
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i]; if (n & 3) continue;
    let st = n >> 2; if (st === 3) { i++; st = ns[i] + 3; }
    if (st) out.add(st);
  }
}

async function analyse(buf) {
  const zin = await JSZip.loadAsync(buf);
  const names = Object.keys(zin.files);
  const read = async n => { const f = zin.file(n); return f ? f.async('string') : ''; };
  const a = { app: '', printer: '', filaments: [], plates: [], warnings: [], bed: 0 };

  const model = await read('3D/3dmodel.model');
  a.app = (model.match(/<metadata name="Application">([^<]*)</) || [])[1] || 'unknown';
  let src = {};
  try { src = JSON.parse(await read('Metadata/project_settings.config') || '{}'); } catch (e) { src = {}; }
  a.printer = src.printer_model || src.printer_settings_id || 'unknown';
  const area = (src.printable_area || []).map(p => p.split('x').map(Number)).filter(p => p.length === 2);
  if (area.length) a.bed = Math.max(...area.map(p => p[0])) - Math.min(...area.map(p => p[0]));

  const cols = src.filament_colour || [], types = src.filament_type || [], ids = src.filament_settings_id || [], temps = src.nozzle_temperature || [];
  const N = Math.max(cols.length, types.length, ids.length);
  // Bambu Studio 2.4 stores one value per nozzle variant: [f1v1, f1v2, f2v1, ...]
  const stride = N > 0 && temps.length > N && temps.length % N === 0 ? temps.length / N : 1;
  for (let i = 0; i < N; i++) a.filaments.push({ slot: i + 1, colour: cols[i] || '#888888', type: types[i] || '?', profile: ids[i] || '', temp: temps[i * stride] || '' });

  // paint states per sub-model object, and empty placeholder parts
  const paintBySub = {};
  for (const n of names.filter(n => /^3D\/Objects\/.+\.model$/i.test(n))) {
    const t = await read(n);
    if (!/<vertex[\s>]/.test(t)) continue;
    for (const m of t.matchAll(/<object\b[^>]*\bid="(\d+)"[\s\S]*?<\/object>/g)) {
      const set = new Set();
      for (const pc of m[0].matchAll(/paint_color="([0-9A-Fa-f]+)"/g)) paintStates(pc[1], set);
      paintBySub['/' + n + '#' + m[1]] = set;
    }
  }
  const comps = {};
  for (const m of model.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    comps[m[1]] = Array.from(m[2].matchAll(/<component\b[^>]*>/g)).map(c => {
      const p = (c[0].match(/p:path="([^"]+)"/) || [])[1]; const o = (c[0].match(/objectid="(\d+)"/) || [])[1];
      return p ? p + '#' + o : null;
    });
  }

  const ms = new DOMParser().parseFromString(await read('Metadata/model_settings.config') || '<config/>', 'text/xml');
  const kids = (el, tag) => Array.from(el.childNodes).filter(c => c.nodeType === 1 && c.nodeName === tag);
  const meta = (el, key) => { const m = kids(el, 'metadata').find(x => x.getAttribute('key') === key); return m ? m.getAttribute('value') : null; };
  const cfg = ms.documentElement;
  const objUse = {}, objName = {};
  for (const o of kids(cfg, 'object')) {
    const id = o.getAttribute('id'); const oe = parseInt(meta(o, 'extruder') || '1', 10) || 1;
    const used = new Set(); objName[id] = meta(o, 'name') || 'object';
    const parts = kids(o, 'part');
    if (!parts.length) used.add(oe);
    parts.forEach((p, i) => {
      if ((p.getAttribute('subtype') || 'normal_part') !== 'normal_part') return;
      const pe = parseInt(meta(p, 'extruder') || '0', 10) || oe; used.add(pe);
      const key = (comps[id] || [])[i]; if (key && paintBySub[key]) paintBySub[key].forEach(x => used.add(x));
    });
    objUse[id] = used;
  }
  const plates = kids(cfg, 'plate');
  for (const [i, pl] of plates.entries()) {
    const used = new Set(); let objs = 0;
    for (const mi of kids(pl, 'model_instance')) { const oid = meta(mi, 'object_id'); (objUse[oid] || []).forEach(x => used.add(x)); objs++; }
    const id = meta(pl, 'plater_id') || String(i + 1);
    const p = { id, name: meta(pl, 'plater_name') || '', filaments: [...used].sort((x, y) => x - y), objects: objs, thumb: null };
    const f = zin.file(`Metadata/plate_${id}.png`); if (f) p.thumb = await f.async('base64');
    a.plates.push(p);
  }
  if (!a.plates.length) a.plates.push({ id: '1', name: '', filaments: a.filaments.map(f => f.slot), objects: Object.keys(objUse).length, thumb: null });
  a.plates.forEach(p => { if (p.filaments.length > 4) a.warnings.push(`Plate ${p.id}${p.name ? ' (' + p.name + ')' : ''} uses ${p.filaments.length} filaments. The U1 has 4 heads: assign them in Orca, or let multiACE swap.`); });
  if (a.bed > 270) a.warnings.push(`Laid out for a ${a.bed} mm bed, larger than the U1's 270 mm. Check that every plate fits, and use Arrange if not.`);
  return a;
}

// ---------- server calls
async function loadProfiles() {
  try {
    const r = await fetch('/api/profiles'); profiles = await r.json();
    $('#profile').innerHTML = profiles.map(p => `<option value="${esc(p.id)}">${esc(p.display_name)}${p.source === 'user' ? ' (user)' : ''}</option>`).join('');
  } catch (e) { $('#profile').innerHTML = '<option value="">Could not load profiles</option>'; }
}

async function suggest(file) {
  const form = new FormData(); form.append('file', file);
  const r = await fetch('/api/suggest-profile', { method: 'POST', body: form });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `suggest failed (${r.status})`);
  return r.json();
}

async function convert(file, profileId) {
  const form = new FormData();
  form.append('file', file);
  form.append('reference_profile', profileId);
  form.append('apply_rules', $('#rules').checked ? 'true' : 'false');
  form.append('clamp_speeds', $('#clamp').checked ? 'true' : 'false');
  form.append('preserve_color_painting', 'true');
  form.append('insert_swap_pauses', $('#pauses').checked ? 'true' : 'false');
  form.append('advanced_overrides', '{}');
  form.append('slot_map', '{}');
  const r = await fetch('/api/convert', { method: 'POST', body: form });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `convert failed (${r.status})`);
  return r.json();
}

// ---------- the Changes summary: short sentences, details on demand
function section(sections, title) { return (sections || []).find(s => s.title === title); }
function changes(result, analysis) {
  const rep = result.diff.report, secs = result.diff.sections, c = result.diff.counts || {};
  const items = [];
  const det = (label, html) => `<details><summary>${esc(label)}</summary><div class="detail">${html}</div></details>`;
  const keyChips = rows => `<div class="keys">${rows.map(r => `<span>${esc(r.key || r)}</span>`).join('')}</div>`;

  const pm = (rep.identity_swaps || []).find(s => s.key === 'printer_model');
  items.push({ cls: '', text: `Printer, bed and G-code swapped: <b>${esc(pm ? pm.from_value : analysis.printer)}</b> → <b>${esc(pm ? pm.to_value : 'Snapmaker U1')}</b>${c.gcode_swaps ? ` (${c.gcode_swaps} G-code blocks)` : ''}.` });

  const clamped = rep.values_clamped || [];
  if (clamped.length) {
    items.push({ cls: '', text: `${clamped.length} speed/acceleration values lowered to the reference profile.`, detail: det(`show ${clamped.length}`,
      `<table class="t"><tr><th>Setting</th><th>Was</th><th>Now</th></tr>${clamped.map(r => `<tr><td class="m">${esc(r.key)}</td><td class="was">${esc(fmt(r.from_value))}</td><td>${esc(fmt(r.to_value))}</td></tr>`).join('')}</table>`) });
  } else {
    items.push({ cls: 'keep', text: `Designer's print settings kept: layer height, infill, walls, supports, speeds and every per-part override.` });
  }

  const rw = rep.settings_rewritten || [];
  if (rw.length) {
    const nil = rw.filter(r => /nil/.test(r.reason)).length, other = rw.length - nil;
    const bits = []; if (nil) bits.push(`${nil} per-part value${nil > 1 ? 's' : ''} Bambu Studio 2.4 saved as <code>X,nil</code>`); if (other) bits.push(`${other} Bambu "auto" value${other > 1 ? 's' : ''} Orca has no equivalent for`);
    items.push({ cls: '', text: `Rewritten so Orca can read them: ${bits.join(' and ')}.`, detail: det(`show ${rw.length}`,
      `<table class="t"><tr><th>Setting</th><th>Where</th><th>Was</th><th>Now</th><th>Why</th></tr>${rw.map(r => `<tr><td class="m">${esc(r.key)}</td><td>${esc(r.scope)}</td><td class="was">${esc(fmt(r.from_value))}</td><td>${esc(fmt(r.to_value))}</td><td class="small">${esc(r.reason)}</td></tr>`).join('')}</table>`) });
  }

  const dropped = rep.keys_dropped || [];
  if (dropped.length) items.push({ cls: '', text: `${dropped.length} Bambu-only settings dropped (no U1 equivalent: AMS, multi-nozzle, Bambu-specific tuning).`, detail: det(`show ${dropped.length}`, keyChips(dropped)) });

  const remaps = rep.slot_remaps || [];
  const moved = remaps.filter(r => r.from_index !== r.to_index);
  const droppedSlots = remaps.filter(r => r.to_index < 0);
  if (droppedSlots.length) items.push({ cls: 'warn', text: `${droppedSlots.length} filament slot${droppedSlots.length > 1 ? 's' : ''} dropped: ${droppedSlots.map(r => r.from_index + 1).join(', ')}.` });
  else if (moved.length) items.push({ cls: '', text: `Filaments remapped onto toolheads: ${moved.map(r => `${r.from_index + 1}→${r.to_index + 1}`).join(', ')}.` });
  else items.push({ cls: 'keep', text: `All ${analysis.filaments.length} filaments kept in their original slots, colours and painted details included.` });

  if (rep.plates_respaced > 1) items.push({ cls: '', text: `${rep.plates_respaced} plates moved onto the U1's 270 mm plate grid (${rep.build_items_moved} parts), so each plate keeps its layout.` });
  else items.push({ cls: '', text: `Parts placed on the U1 bed.` });

  const rules = rep.rules_matched || [];
  if (rules.length) items.push({ cls: 'warn', text: `${rules.length} filament rule${rules.length > 1 ? 's' : ''} applied: ${rules.map(r => r.rule_name).join(', ')}. These overwrite filament settings for the whole project.`, detail: det('show', `<table class="t">${rules.map(r => `<tr><td class="m">${esc(r.rule_name)}</td><td>${esc(Object.keys(r.overrides_applied || {}).join(', '))}</td></tr>`).join('')}</table>`) });

  const swaps = rep.swap_instructions || [];
  if (swaps.length) items.push({ cls: 'warn', text: `${swaps.length} filament swap pause${swaps.length > 1 ? 's' : ''} inserted (M600): see the classic UI for the per-layer list.` });

  if (c.slice_artifacts_stripped) items.push({ cls: '', text: `${c.slice_artifacts_stripped} stale slice cache files removed; Orca re-slices for the U1.` });
  for (const w of analysis.warnings) items.push({ cls: 'warn', text: esc(w) });
  return items;
}

// ---------- render
function render(statusText, statusKind) {
  const t = $('#ticket');
  if (!current) {
    t.innerHTML = `<div class="empty"><strong>Nothing converted yet</strong>Drop a project file on the plate. You'll see its filaments and plates here, then the converted file and what changed.</div>`;
    return;
  }
  const a = current.analysis, r = current.result;
  const colourOf = n => (a.filaments[n - 1] || {}).colour || '#888';
  const spools = a.filaments.map(f => `<div class="spool"><span class="dot" style="background:${esc(f.colour)};color:${fg(f.colour)}">${f.slot}</span><span class="t">${esc(f.type)}${f.temp ? ` · ${esc(f.temp)} °C` : ''}</span><span class="p">${esc(f.profile || '—')}</span></div>`).join('');
  const plates = a.plates.map(p => {
    const n = p.filaments.length;
    return `<div class="pcard${n > 4 ? ' over4' : ''}">
      <div class="thumb">${p.thumb ? `<img alt="Plate ${esc(p.id)} preview" src="data:image/png;base64,${p.thumb}">` : `<span>${esc(p.id)}</span>`}</div>
      <div class="pname">${esc(p.id)}. ${esc(p.name || 'Plate ' + p.id)}</div>
      <div class="chips">${p.filaments.map(x => `<span class="chip" title="Filament ${x}" style="background:${esc(colourOf(x))};color:${fg(colourOf(x))}">${x}</span>`).join('')}</div>
      <div class="pmeta"><span>${p.objects} part${p.objects === 1 ? '' : 's'}</span><span class="heads${n > 4 ? ' bad' : ''}">${n}/4 heads</span></div>
    </div>`;
  }).join('');
  const items = r ? changes(r, a) : a.warnings.map(w => ({ cls: 'warn', text: esc(w) }));
  const list = items.map(i => `<li class="${i.cls}"><span class="txt">${i.text}${i.detail || ''}</span></li>`).join('');
  const outName = r ? r.download_name : current.file.name.replace(/\.3mf$/i, '') + '-U1.3mf';
  const dl = r ? `<a class="btn" href="/api/download/${encodeURIComponent(r.job_id)}" download="${esc(outName)}">Download .3mf</a>` : `<span class="btn" aria-disabled="true">Converting…</span>`;
  t.innerHTML = `
    <section class="head">
      <div class="file">
        <div class="name">${esc(outName)}</div>
        <div class="route">${esc(a.app)} · <b>${esc(a.printer)}</b> → <b>Snapmaker U1</b>${r ? ` · ${esc(r.diff.report.reference_profile)}` : ''}</div>
      </div>
      <div class="actions">${dl}</div>
      ${statusText ? `<div class="status ${statusKind || ''}" id="status">${esc(statusText)}</div>` : ''}
    </section>
    <section><h2>Filaments · ${a.filaments.length}</h2><div class="spools">${spools}</div>
      <p class="small">Profile names and temperatures are the designer's. Pick your own filament profiles in Orca; that replaces them per slot.</p></section>
    <section><h2>Plates · ${a.plates.length}</h2><div class="plates">${plates}</div></section>
    <section><h2>Changes · ${items.length}</h2><ul class="fixes">${list}</ul></section>`;
}

// ---------- flow
async function handle(file) {
  if (!file) return;
  if (!/\.3mf$/i.test(file.name)) { current = null; render(); alert(`${file.name} isn't a .3mf file. Download the project file from MakerWorld (the .3mf), not the STL or the sliced G-code.`); return; }
  $('#reconvert').disabled = true;
  current = { file, analysis: { app: '', printer: '', filaments: [], plates: [], warnings: [] }, result: null };
  try {
    current.analysis = await analyse(await file.arrayBuffer());
  } catch (e) { current.analysis.warnings.push(`Could not preview the file: ${e.message || e}`); }
  render('Matching a reference profile…');
  try {
    const s = await suggest(file);
    if (s.profile_id && profiles.some(p => p.id === s.profile_id)) { $('#profile').value = s.profile_id; $('#automatch').hidden = false; }
    if (s.already_converted) current.analysis.warnings.push('This file is already set to the Snapmaker U1. Convert the original Bambu file instead.');
  } catch (e) { $('#automatch').hidden = true; }
  await runConvert();
}

async function runConvert() {
  if (!current) return;
  const profileId = $('#profile').value;
  if (!profileId) { render('No reference profile selected.', 'err'); return; }
  current.result = null;
  render('Converting ' + current.file.name + '…');
  try {
    current.result = await convert(current.file, profileId);
    render();
  } catch (e) {
    render(`Couldn't convert ${current.file.name}: ${e.message || e}`, 'err');
  }
  $('#reconvert').disabled = false;
}

const drop = $('#drop'), pick = $('#pick');
drop.addEventListener('click', () => pick.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.click(); } });
pick.addEventListener('change', () => { handle(pick.files[0]); pick.value = ''; });
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handle(e.dataTransfer.files[0]));
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (!drop.contains(e.target)) handle(e.dataTransfer.files[0]); });
$('#reconvert').addEventListener('click', runConvert);
$('#profile').addEventListener('change', () => { $('#automatch').hidden = true; });
render();
loadProfiles();
