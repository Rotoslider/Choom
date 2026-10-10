// Glass Studio page: review rendered clips, arrange what's on the glass (drag and drop), plan clips
// from the library and render them, edit looks. Talks to studio/server.py.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, { tip, ...props } = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  if (tip) e.dataset.tip = tip;
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
};
const clipUrl = (n) => `/media/clip/${encodeURIComponent(n)}.mp4`;
const sheetUrl = (n, v) => `/media/sheet/${encodeURIComponent(n)}.jpg?v=${v || 0}`;
const pictureUrl = (f) => `/media/picture/${encodeURIComponent(f)}`;
const short = (cid, n) => n.replace(`${cid}_`, '');
const secondsOf = (c) => c.seconds || ({ 124: 5, 141: 6, 175: 7, 243: 10, 294: 12, 362: 15 }[c.frames] || 5);

const state = {
  chooms: [], cid: null, choom: null, tab: 'review',
  reviewFilter: 'rendered', reviewLook: '', reviewShown: 40,
  planLook: null, options: [], picked: new Set(), edits: {}, jobs: [], minutesPerClip: 5.5,
};
try { Object.assign(state, JSON.parse(localStorage.getItem('glass-studio') || '{}'), { choom: null, options: [], picked: new Set(), edits: {}, jobs: [] }); } catch { /* fine without */ }
state.planLooks ||= {};  // the look last planned for, per Choom
// The address keeps the view (#optic/glass, #genesis/review/kept), so a view can be linked or reloaded.
const fromHash = () => {
  const [cid, tab, filter] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (cid) state.cid = cid;
  if (['review', 'glass', 'plan', 'looks'].includes(tab)) state.tab = tab;
  if (['rendered', 'flagged', 'kept', 'dropped', 'all'].includes(filter)) state.reviewFilter = filter;
};
fromHash();
const remember = () => {
  const hash = `#${state.cid || ''}/${state.tab}${state.tab === 'review' ? `/${state.reviewFilter}` : ''}`;
  if (state.cid && location.hash !== hash) history.replaceState(null, '', hash);
  try { localStorage.setItem('glass-studio', JSON.stringify({ cid: state.cid, tab: state.tab, reviewFilter: state.reviewFilter, planLooks: state.planLooks })); } catch { /* fine without */ }
};

function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}
const attempt = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { toast(e.message, true); } };

// --- Chooms ---------------------------------------------------------------------------------------
async function loadChooms() {
  const data = await api('/api/chooms');
  state.chooms = data.chooms;
  state.minutesPerClip = data.minutesPerClip;
  state.cleanPrompt = data.cleanPrompt;
  const nav = $('#chooms');
  nav.replaceChildren(...state.chooms.map((c) => {
    const b = el('button', { type: 'button', onclick: () => openChoom(c.id), tip: `${c.name}: ${c.onGlass} clips on the glass${c.counts.rendered ? `, ${c.counts.rendered} to review` : ''}${c.counts.planned ? `, ${c.counts.planned} planned` : ''}` },
      el('span', { className: 'swatch' }), c.name, el('small', {}, `${c.onGlass}`));
    b.style.setProperty('--c', c.color || '#9fb4ff');
    b.dataset.id = c.id;
    return b;
  }));
  if (!state.chooms.length) {
    $('#intro').replaceChildren(
      el('h2', {}, 'No Chooms here yet'),
      el('p', {}, 'Click ', el('b', {}, '+ New Choom'), ' to bring your first one to the glass: a picture of her is all it takes to start. ',
        'The guide is in studio/docs/tutorial-new-choom.md.'),
      el('p', { className: 'muted' }, 'Clips made before the Studio can be adopted with python3 studio/studio.py import.'));
    return;
  }
  openChoom(state.chooms.some((c) => c.id === state.cid) ? state.cid : state.chooms[0].id);
}

async function openChoom(cid, keepScroll = false) {
  state.cid = cid;
  remember();
  const y = window.scrollY;
  state.choom = await api(`/api/choom/${cid}`);
  document.documentElement.style.setProperty('--tint', state.choom.color || '#9fb4ff');
  $$('#chooms button').forEach((b) => b.classList.toggle('on', b.dataset.id === cid));
  $('#intro').hidden = true;
  $('#choom').hidden = false;
  render();
  if (keepScroll) window.scrollTo(0, y);
}
const refresh = attempt(async () => { await openChoom(state.cid, true); });

function render() {
  const c = state.choom;
  const counts = Object.values(c.clips).reduce((a, k) => ({ ...a, [k.status]: (a[k.status] || 0) + 1 }), {});
  $('#choomName').textContent = c.name;
  $('#choomLine').textContent = [
    `${c.sequence.length} clips on the glass`, `${Object.keys(c.looks).length} looks`,
    counts.rendered ? `${counts.rendered} to review` : null, counts.planned ? `${counts.planned} planned` : null,
    counts.queued ? `${counts.queued} rendering` : null,
  ].filter(Boolean).join(' · ');
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== state.tab; });
  ({ review: renderReview, glass: renderGlass, plan: renderPlan, looks: renderLooks })[state.tab]();
}

$$('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; remember(); render(); }));

// --- Review ---------------------------------------------------------------------------------------
function lookOptions(select, value, withAll) {
  const looks = lookOrder(state.choom.looks);
  select.replaceChildren(...(withAll ? [el('option', { value: '' }, 'All looks')] : []),
    ...looks.map((l) => el('option', { value: l, selected: l === value }, l)));
}

function renderReview() {
  lookOptions($('#reviewLook'), state.reviewLook, true);
  $$('#reviewFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === state.reviewFilter));
  const c = state.choom;
  const f = state.reviewFilter;
  const names = Object.keys(c.clips).filter((n) => {
    const k = c.clips[n];
    if (state.reviewLook && k.from !== state.reviewLook) return false;
    if (f === 'all') return k.status !== 'planned' && k.status !== 'queued';
    if (f === 'flagged') return (k.flags || []).length && ['rendered', 'kept'].includes(k.status);
    return k.status === f;
  }).sort((a, b) => (c.clips[b].rendered || '').localeCompare(c.clips[a].rendered || '') || a.localeCompare(b));
  const grid = $('#reviewGrid');
  if (!names.length) {
    grid.replaceChildren(el('div', { className: 'empty' },
      f === 'rendered' ? 'Nothing waiting for review. Plan some clips and render them, or look at the kept ones.' : 'No clips here.'));
    $('#reviewMore').replaceChildren();
    return;
  }
  grid.replaceChildren(...names.slice(0, state.reviewShown).map(reviewCard));
  $('#reviewMore').replaceChildren(names.length > state.reviewShown
    ? el('button', { className: 'ghost', type: 'button', onclick: () => { state.reviewShown += 40; renderReview(); } },
      `Show more (${names.length - state.reviewShown} left)`)
    : el('span', {}, `${names.length} clip${names.length === 1 ? '' : 's'}`));
}

const FLAG_TIPS = {
  background: 'The black around her lifts: fog, a glow or a flash rolling in',
  'push-in': 'She grows in the frame: the camera pushed in or zoomed',
  color: 'Her light or colour drifts from her picture (sometimes on purpose: a fade, a glow)',
  seam: "The last frame doesn't come back to the first: a jump each time it loops",
  cut: 'A sudden jump mid-clip: a new shot',
};

function reviewCard(name) {
  const c = state.choom.clips[name];
  const cid = state.cid;
  const hasSheet = !!c.checks;
  const sheet = el('div', { className: `sheet${hasSheet ? '' : ' missing'}`, tip: 'Eight frames, first to last. Click to play the clip' },
    hasSheet ? null : 'no sheet yet');
  if (hasSheet) sheet.style.backgroundImage = `url("${sheetUrl(name, c.rendered || c.changed)}")`;
  sheet.addEventListener('click', () => play(name));
  const note = el('input', { className: 'note', placeholder: 'note (why dropped, what to fix)', value: c.note || '' });
  const decide = attempt(async (status) => {
    state.choom = (await api(`/api/choom/${cid}/status`, { names: [name], status, note: note.value })).choom;
    toast(`${short(cid, name)}: ${status}`);
    const next = card.nextElementSibling;
    if (['rendered', 'flagged'].includes(state.reviewFilter) && status !== 'rendered') {
      card.remove();
      next?.focus();
      render();
    } else render();
  });
  const reroll = attempt(async () => {
    state.choom = (await api(`/api/choom/${cid}/reroll`, { names: [name] })).choom;
    toast(`${short(cid, name)} planned again with a new seed; render it from Plan & render`);
    render();
  });
  const card = el('article', { className: `card ${c.status}`, tabIndex: 0 },
    sheet,
    el('div', { className: 'card-body' },
      el('div', { className: 'card-title' },
        el('code', {}, short(cid, name)),
        el('span', { className: 'tag' }, c.from === c.to ? c.from : `${c.from} → ${c.to}`),
        el('span', { className: `tag status-${c.status}` }, c.status),
        `${secondsOf(c)} s`,
        ...(c.flags || []).map((f) => el('span', { className: 'tag flag', tip: FLAG_TIPS[f] || f }, f)),
        state.choom.sequence.includes(name) ? el('span', { className: 'tag' }, 'on the glass') : null),
      el('p', { className: 'action' }, c.action || '(prompt not recorded)'),
      el('div', { className: 'card-buttons' },
        el('button', { className: 'keep', type: 'button', onclick: () => decide('kept'), tip: 'Keep it (K): it can go on the glass' }, 'Keep'),
        el('button', { className: 'drop', type: 'button', onclick: () => decide('dropped'), tip: 'Drop it (D): it stays in her project, off the glass' }, 'Drop'),
        el('button', { type: 'button', onclick: reroll, tip: 'Re-roll (R): plan it again with a new seed (edit the wording first if you like); the old take is kept' }, 'Re-roll'),
        note)));
  card.addEventListener('keydown', (e) => {
    if (e.target === note) return;
    const k = e.key.toLowerCase();
    if (k === 'k') decide('kept');
    else if (k === 'd') decide('dropped');
    else if (k === 'r') reroll();
    else if (k === ' ') { e.preventDefault(); play(name); }
    else if (k === 'arrowright' || k === 'arrowdown' || k === 'j') { e.preventDefault(); card.nextElementSibling?.focus(); }
    else if (k === 'arrowleft' || k === 'arrowup') { e.preventDefault(); card.previousElementSibling?.focus(); }
  });
  return card;
}

$$('#reviewFilter button').forEach((b) => b.addEventListener('click', () => {
  state.reviewFilter = b.dataset.f; state.reviewShown = 40; remember(); renderReview();
}));
$('#reviewLook').addEventListener('change', (e) => { state.reviewLook = e.target.value; state.reviewShown = 40; renderReview(); });
$('#makeSheets').addEventListener('click', attempt(async () => {
  const c = state.choom;
  const names = Object.keys(c.clips).filter((n) => !c.clips[n].checks && ['rendered', 'kept', 'dropped'].includes(c.clips[n].status));
  if (!names.length) return toast('Every clip has its sheet');
  await api('/api/review', { choom: state.cid, clips: names });
  toast(`Making ${names.length} sheets (about ${Math.max(1, Math.round(names.length / 6))} s each batch); they appear as they finish`);
  pollJobs();
}));

function play(name) {
  const v = $('#playerVideo');
  v.src = clipUrl(name);
  $('#playerName').textContent = name;
  $('#player').showModal();
  v.play().catch(() => {});
}
$('#playerClose').addEventListener('click', () => $('#player').close());
$('#player').addEventListener('close', () => { const v = $('#playerVideo'); v.pause(); v.removeAttribute('src'); v.load(); });

// --- On the glass (drag and drop) -----------------------------------------------------------------
// Her looks in a sensible order: main, relaxed, outfits, full body, asleep.
const rank = (l) => (l === 'main' ? 0 : l === 'relaxed' ? 1 : l === 'full' ? 3 : l === 'asleep' ? 4 : 2);
const lookOrder = (looks) => Object.keys(looks).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

function renderGlass() {
  const c = state.choom;
  const bar = $('#buildBar');
  const { added, removed } = c.glass;
  const changes = added.length || removed.length
    ? `Not built yet: ${added.length} to add, ${removed.length} to take off.`
    : 'The glass shows this sequence.';
  const build = el('button', { className: 'primary', type: 'button', disabled: !!c.problems.length || !(added.length || removed.length), tip: 'Cut-outs, depth and reliefs for new clips (only new ones are encoded), then the glass reloads once nobody is talking' },
    'Build and put on the glass');
  build.addEventListener('click', attempt(async () => {
    await api('/api/build', { choom: state.cid });
    toast('Building: cut-outs, depth and reliefs for the new clips, then the glass reloads when she is quiet');
    pollJobs();
  }));
  if (!c.inManifest) {
    const hasMain = !!c.looks.main?.picture;
    const kept = c.sequence.length;
    const still = el('button', { className: 'primary', type: 'button', disabled: !hasMain, tip: 'Make her still relief (cut-out, depth, mouth) and add her to the glass; her clips replace it once built' }, 'Put her on the glass');
    still.addEventListener('click', attempt(async () => {
      await api('/api/still', { choom: state.cid });
      toast('Making her still relief (cut-out, depth, mouth); the glass reloads with her when it is quiet');
      pollJobs();
    }));
    bar.replaceChildren(el('div', { className: 'changes' }, el('div', {}, `${c.name} isn't on the glass yet.`),
      el('ol', { className: 'steps' },
        el('li', { className: hasMain ? 'done' : '' }, 'Pick her main picture (Looks).'),
        el('li', {}, 'Put her on the glass: her still relief, so the glass knows her.'),
        el('li', { className: kept ? 'done' : '' }, 'Plan Essentials and quiet moments for her main look, render, keep the good ones.'),
        el('li', {}, 'Build: her clips replace the still picture.'))), still);
    $('#glassLooks').replaceChildren();
    if (!Object.keys(c.clips).length) return;
  } else bar.replaceChildren(
    el('div', { className: 'changes' }, el('div', {}, changes),
      ...c.problems.map((p) => el('div', { className: 'problem' }, p)),
      c.built ? el('div', { className: 'muted' }, `Last built ${c.built.time.replace('T', ' ')} (${c.built.clips} clips, ${c.built.minutes} min)`) : null),
    build);

  const looks = lookOrder(c.looks);
  $('#glassLooks').replaceChildren(...looks.map((look) => {
    const on = c.sequence.filter((n) => c.clips[n]?.from === look);
    const off = Object.keys(c.clips).filter((n) => c.clips[n].from === look && c.clips[n].status === 'kept' && !c.sequence.includes(n)).sort();
    const s = c.stats[look] || { onGlass: 0, quiet: 0, minutes: 0 };
    const pic = c.looks[look].picture;
    const allOn = off.length ? el('button', {
      className: 'ghost small', type: 'button', tip: `Put all ${off.length} kept clips of this look on the glass`,
      onclick: attempt(async () => {
        state.choom = (await api(`/api/choom/${state.cid}/place`, { names: off, on: true })).choom;
        toast(`${off.length} clips added to ${look}; build to put them on the glass`);
        renderGlass();
      }),
    }, `Put all ${off.length} on the glass`) : null;
    return el('div', { className: 'look-block' },
      el('div', { className: 'look-head' },
        pic ? el('img', { src: pictureUrl(pic), alt: '', loading: 'lazy' }) : null,
        el('h3', {}, look),
        el('span', { className: 'stat' }, `${s.onGlass} on the glass · ${s.quiet} quiet moments · ${s.minutes} min before one repeats`),
        allOn),
      el('div', { className: 'lane-label' }, 'On the glass'),
      lane(look, on, true),
      el('div', { className: 'lane-label' }, `Kept, not on the glass (${off.length})`),
      lane(look, off, false));
  }));
}

let dragged = null;
function lane(look, names, on) {
  const box = el('div', { className: `lane${on ? ' on' : ''}` }, ...names.map((n) => tile(n, on)));
  box.dataset.look = look;
  box.dataset.empty = on ? 'Drag kept clips here to put them on the glass' : 'Drag clips here to take them off the glass';
  box.addEventListener('dragover', (e) => {
    if (!dragged || state.choom.clips[dragged].from !== look) return;
    e.preventDefault();
    box.classList.add('over');
  });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', attempt(async (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const name = dragged;
    if (!name) return;
    const target = e.target.closest('.tile');
    const seq = state.choom.sequence;
    if (on && target && target.dataset.name !== name && seq.includes(target.dataset.name) && target.dataset.name !== seq[0]) {
      // Dropped onto a clip on the glass: swap them (the dragged one takes its place).
      const next = seq.filter((n) => n !== name).map((n) => (n === target.dataset.name ? name : n));
      state.choom = (await api(`/api/choom/${state.cid}/sequence`, { sequence: next })).choom;
      toast(`${short(state.cid, name)} replaces ${short(state.cid, target.dataset.name)}`);
    } else if (on !== seq.includes(name)) {
      state.choom = (await api(`/api/choom/${state.cid}/place`, { names: [name], on })).choom;
    }
    renderGlass();
  }));
  return box;
}

function tile(name, on) {
  const c = state.choom.clips[name];
  const main = name === state.choom.sequence[0];
  const t = el('div', {
    className: `tile${main ? ' main' : ''}${(c.flags || []).length ? ' flagged' : ''}`, draggable: !main,
    tip: `${short(state.cid, name)} · ${secondsOf(c)} s${c.flags?.length ? ` · flagged: ${c.flags.join(', ')}` : ''}${main ? ' · her main idle (stays first)' : ''}\n${c.action || ''}`,
  });
  t.dataset.name = name;
  if (c.checks) t.style.backgroundImage = `url("${sheetUrl(name, c.rendered || c.changed)}")`;
  t.addEventListener('dragstart', (e) => { dragged = name; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  t.addEventListener('dragend', () => { dragged = null; t.classList.remove('dragging'); });
  t.addEventListener('dragenter', () => { if (dragged && dragged !== name && on) t.classList.add('target'); });
  t.addEventListener('dragleave', () => t.classList.remove('target'));
  t.addEventListener('drop', () => t.classList.remove('target'));
  let hover;
  t.addEventListener('mouseenter', () => {
    hover = setTimeout(() => {
      const v = el('video', { src: clipUrl(name), muted: true, loop: true, autoplay: true, playsInline: true });
      t.append(v);
    }, 250);
  });
  t.addEventListener('mouseleave', () => { clearTimeout(hover); $('video', t)?.remove(); });
  t.addEventListener('dblclick', () => play(name));
  return t;
}

// --- Plan & render --------------------------------------------------------------------------------
async function renderPlan() {
  const c = state.choom;
  state.planLook = state.planLooks[state.cid];
  if (!state.planLook || !c.looks[state.planLook]) state.planLook = c.sequence.length ? c.clips[c.sequence[0]].from : Object.keys(c.looks)[0];
  lookOptions($('#planLook'), state.planLook, false);
  const look = c.looks[state.planLook];
  $('#planLookInfo').textContent = look.picture ? `starts and ends on ${look.picture}` : 'this look has no picture yet';
  const [{ options }, { packs }] = await Promise.all([api(`/api/options/${state.cid}/${encodeURIComponent(state.planLook)}`), api('/api/packs')]);
  state.options = options;
  renderLibrary(packs);
  renderPlanned();
}

function renderLibrary(packs) {
  const byPack = {};
  for (const o of state.options) (byPack[o.pack] ||= []).push(o);
  const lib = $('#library');
  const blocks = packs.filter((p) => byPack[p.id]).map((p) => {
    const acts = byPack[p.id];
    const fresh = acts.filter((o) => !o.have.length);
    const pick = el('button', { className: 'ghost', type: 'button', tip: 'Tick every action in this pack she has no clip for yet' }, `Pick the ${fresh.length} she doesn't have`);
    pick.addEventListener('click', () => { fresh.forEach((o) => state.picked.add(o.key + '|' + o.pack)); renderLibrary(packs); });
    return el('section', { className: 'pack' },
      el('header', {}, el('h3', {}, p.title), el('p', {}, p.about), fresh.length ? pick : el('span', { className: 'muted' }, 'she has them all')),
      el('div', { className: 'acts' }, ...acts.map((o) => {
        const id = o.key + '|' + o.pack;
        const box = el('input', { type: 'checkbox', checked: state.picked.has(id), disabled: !!o.have.length && !o.numbered });
        box.addEventListener('change', () => { box.checked ? state.picked.add(id) : state.picked.delete(id); updatePlanButton(); });
        return el('label', { className: `act${o.have.length ? ' have' : ''}` }, box,
          el('span', { className: 'k' }, short(state.cid, o.name),
            el('small', {}, `${o.seconds} s${o.have.length ? ` · has ${o.have.map((n) => short(state.cid, n)).join(', ')}` : ''}`),
            o.hands ? el('span', { className: 'hands', tip: 'Uses a hand: if her pose holds something (a heart, crossed arms), edit the planned wording to say how she frees it and puts it back' }, 'uses a hand') : null),
          el('span', { className: 't' }, o.text));
      })));
  });
  const add = el('button', { className: 'primary', type: 'button', id: 'planAdd', tip: 'Add the ticked actions to her plan: each gets its name, prompt and seed' });
  add.addEventListener('click', attempt(async () => {
    const items = state.options.filter((o) => state.picked.has(o.key + '|' + o.pack)).map((o) => ({ pack: o.pack, key: o.key }));
    const { results, choom } = await api(`/api/choom/${state.cid}/plan`, { look: state.planLook, items });
    state.choom = choom;
    state.picked.clear();
    const made = results.filter(([n]) => n);
    const skipped = results.filter(([n]) => !n).map(([, m]) => m);
    toast(`${made.length} clips planned${skipped.length ? `; skipped: ${skipped.join('; ')}` : ''}`, !!skipped.length && !made.length);
    render();
  }));
  lib.replaceChildren(...blocks, el('div', { className: 'plan-actions' }, add));
  updatePlanButton();
}

function updatePlanButton() {
  const b = $('#planAdd');
  if (!b) return;
  const n = state.options.filter((o) => state.picked.has(o.key + '|' + o.pack)).length;
  b.disabled = !n;
  b.textContent = n ? `Plan ${n} clip${n > 1 ? 's' : ''} in ${state.planLook}` : 'Pick actions to plan';
}

$('#planLook').addEventListener('change', (e) => { state.planLook = state.planLooks[state.cid] = e.target.value; remember(); state.picked.clear(); renderPlan(); });
$('#customAdd').addEventListener('click', attempt(async () => {
  const key = $('#customKey').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const text = $('#customText').value.trim();
  if (!key || !text) return toast('Give it a short name and say what she does', true);
  const { results, choom } = await api(`/api/choom/${state.cid}/plan`, {
    look: state.planLook, items: [{ key, text, seconds: Number($('#customSeconds').value), kind: $('#customKind').value }],
  });
  state.choom = choom;
  const [name, message] = results[0];
  toast(name ? `${short(state.cid, name)} planned${message !== 'ok' ? ` (check: ${message})` : ''}` : message, !name);
  if (name) { $('#customKey').value = ''; $('#customText').value = ''; }
  render();
}));

function renderPlanned() {
  const c = state.choom;
  const planned = Object.keys(c.clips).filter((n) => c.clips[n].status === 'planned');
  const queued = Object.keys(c.clips).filter((n) => c.clips[n].status === 'queued');
  const list = $('#planned');
  list.replaceChildren(
    ...(planned.length ? planned.map(plannedItem) : [el('p', { className: 'muted' }, 'Nothing planned. Pick actions on the left.')]),
    queued.length ? el('p', { className: 'muted' }, `${queued.length} rendering now`) : null);
  const minutes = Math.round(planned.reduce((a, n) => a + state.minutesPerClip * (c.clips[n].frames || 124) / 124, 0));
  const box = $('#renderBox');
  if (!planned.length) { box.replaceChildren(); return; }
  const when = el('input', { type: 'time', value: '23:00' });
  const go = (at) => attempt(async () => {
    await api('/api/render', { chooms: [state.cid], at });
    toast(at ? `Queued for ${new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Rendering started');
    await refresh();
    pollJobs();
  })();
  box.replaceChildren(
    el('div', {}, `${planned.length} clips · about ${minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`} of rendering. `,
      el('span', { className: 'muted' }, 'The glass runs slower while the GPU renders; about one clip in six comes out wrong, so review them all.')),
    el('div', { className: 'row' },
      el('button', { className: 'primary', type: 'button', onclick: () => go(0), tip: 'Queue every planned clip and start Wan2GP now (the glass runs slower meanwhile)' }, 'Render now'),
      el('span', { className: 'muted' }, 'or at'), when,
      el('button', {
        className: 'ghost', type: 'button', onclick: () => {
          const [h, m] = when.value.split(':').map(Number);
          const t = new Date(); t.setHours(h, m, 0, 0);
          if (t < new Date()) t.setDate(t.getDate() + 1);
          go(Math.round(t / 1000));
        },
        tip: 'Start the render at this time (tonight, while the glass is quiet)',
      }, 'Schedule')));
}

function plannedItem(name) {
  const c = state.choom.clips[name];
  const lint = lintOf(c.prompt, c.from === c.to);
  const text = el('textarea', { rows: 3, value: c.action || '' });
  const editing = el('div', { hidden: true }, text,
    el('div', { className: 'row' },
      el('button', {
        className: 'ghost', type: 'button', onclick: attempt(async () => {
          state.choom = (await api(`/api/choom/${state.cid}/rewrite`, { name, text: text.value })).choom;
          renderPlanned();
        }),
      }, 'Save')));
  return el('div', { className: 'planned-item' },
    el('div', { className: 'row' }, el('code', {}, short(state.cid, name)), el('span', { className: 'tag' }, c.from), `${secondsOf(c)} s`,
      c.history?.length ? el('span', { className: 'tag' }, `take ${c.history.length + 1}`) : null),
    el('div', { className: 'muted' }, c.action || ''),
    ...lint.map((w) => el('div', { className: 'lint' }, w)),
    editing,
    el('div', { className: 'row' },
      el('button', { className: 'ghost', type: 'button', onclick: () => { editing.hidden = !editing.hidden; }, tip: 'Change what she does; the prompt is rebuilt from her look' }, 'Edit'),
      el('button', {
        className: 'ghost', type: 'button', onclick: attempt(async () => {
          state.choom = (await api(`/api/choom/${state.cid}/unplan`, { names: [name] })).choom;
          renderPlanned();
        }),
        tip: c.history?.length ? 'Forget this re-roll and go back to the take she had' : 'Take it out of the plan',
      }, c.history?.length ? 'Keep the old take' : 'Remove')));
}

// The same checks as prompts.py, so the page can warn before anything is queued.
const LESSONS = [
  [/\b(no|without|free of) (smoke|mist|fog|haze|glow|light effects?|particles)\b/i, 'names an effect you don’t want (naming it brings it)'],
  [/\b(breath|breathe|breathes|breathing|sigh|sighs|sighing|exhale|exhales|inhale|inhales)\b/i, 'breathing words can bring fog'],
  [/\b(leans? (in|forward|closer)|studies (the viewer )?closely|peers? at|close-?up|moves? closer|steps? (toward|towards|closer))\b/i, 'draws the eye to her face: the camera pushes in'],
  [/\b(zoom|zooms|zooming|dolly|pans|panning|tracking shot|camera moves?)\b/i, 'camera words outside the camera line'],
];
const CAMERA = 'The camera stays locked off, framed exactly as at the start, and never zooms or pushes in.';
function lintOf(prompt, loop) {
  if (!prompt) return [];
  const body = prompt.split('\noverall_soundscape')[0].replace(CAMERA, '');
  const out = LESSONS.filter(([re]) => re.test(body)).map(([re, why]) => `“${body.match(re)[0]}”: ${why}`);
  if (!body.includes('plain pure black background')) out.push('say “a plain pure black background” in the look’s subject line');
  if (loop && !body.includes('ends exactly as she began')) out.push('a loop should end “exactly as she began”');
  return out;
}

// --- Looks ----------------------------------------------------------------------------------------
function renderLooks() {
  const c = state.choom;
  renderOutfitForm();
  renderDrafts();
  $('#looksGrid').replaceChildren(...lookOrder(c.looks).map((look) => {
    const l = c.looks[look];
    const subject = el('textarea', { rows: 5, value: l.subject || '' });
    const keep = el('textarea', { rows: 2, value: l.keep || '' });
    const ending = el('textarea', { rows: 2, value: l.ending || '' });
    const save = el('button', {
      className: 'ghost', type: 'button', onclick: attempt(async () => {
        state.choom = (await api(`/api/choom/${state.cid}/look`, { look, subject: subject.value, keep: keep.value, ending: ending.value })).choom;
        toast(`${look} saved; clips planned from now on use it`);
      }),
      tip: 'Save the look; clips planned from now on use it (rendered clips keep their prompts)',
    }, 'Save');
    const s = c.stats[look] || { onGlass: 0 };
    return el('article', { className: 'look-card' },
      l.picture ? el('img', { src: pictureUrl(l.picture), alt: `${c.name}, ${look}`, loading: 'lazy' }) : el('div', { className: 'empty' }, 'no picture'),
      el('div', {},
        el('h3', {}, look),
        el('p', { className: 'muted' }, `${l.picture || 'no picture'} · ${s.onGlass} clips on the glass`),
        el('label', {}, 'Subject', subject), el('label', {}, 'Keep line', keep), el('label', {}, 'Loop ending', ending),
        el('div', { className: 'row' }, save)));
  }));
}

// --- New looks: outfits, full body, asleep (Klein) -------------------------------------------------
const draftUrl = (f) => `/media/draft/${encodeURIComponent(f.replace(/^drafts\//, ''))}`;
const WHEN = { evening: 'evenings, 6 to 11 pm', cold: 'cold days (under 45°F)', hot: 'hot days (over 85°F)', day: 'daytime, taking turns with her usual clothes' };
let promptEdited = false;
const outfitKind = () => $('#outfitKind').value;
// The same instructions as studio/pictures.py, shown so they can be edited before Klein runs.
function kleinPrompt() {
  const base = state.choom.looks[$('#outfitBase').value] || {};
  const wearing = $('#outfitWearing').value.trim().replace(/\.$/, '');
  const keep = (base.kleinKeep || 'her face, expression, hair and pose').replace(/[,. ]+$/, '');
  if (outfitKind() === 'full') {
    return 'Show her from head to toe, standing relaxed and facing the viewer, her whole figure in frame with a little black space above her head and below her feet. '
      + `Keep ${keep} exactly as in the picture, with the same light on the same pure black background.${wearing ? ` She wears ${wearing}.` : ''}`;
  }
  if (outfitKind() === 'asleep') {
    return 'She has dozed off peacefully: her eyes are gently closed, her face is soft and relaxed, and her head tips slightly down and to one side. '
      + `Keep everything else exactly the same: ${keep}, the lighting, the framing, and the pure black background.`;
  }
  return `Change her clothes: she now wears ${wearing || '…'}. Keep everything else exactly the same: ${keep}, the lighting, the framing, and the pure black background.`;
}
function outfitLookId() {
  if (outfitKind() !== 'outfit') return outfitKind();
  const name = $('#outfitName').value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${$('#outfitBase').value}@${$('#outfitWhen').value}${name}`;
}
function updateOutfitForm() {
  const kind = outfitKind();
  $$('#newOutfit .when').forEach((e) => { e.hidden = kind !== 'outfit'; });
  $('#newOutfit .wearing').hidden = kind === 'asleep';
  $('#outfitWearingLabel').textContent = kind === 'full' ? 'What she wears below the waist (optional; her top is kept)' : 'She now wears';
  if (!promptEdited) $('#outfitPrompt').value = kleinPrompt();
  const id = outfitLookId();
  $('#outfitLook').textContent = state.choom.looks[id]?.picture ? `she already has ${id}${kind === 'outfit' ? ': give it a name' : ''}` : `becomes the look ${id}`;
}
function renderOutfitForm() {
  const bases = lookOrder(state.choom.looks).filter((l) => !l.includes('@') && !['full', 'asleep'].includes(l) && state.choom.looks[l].picture);
  const home = state.choom.sequence.length ? state.choom.clips[state.choom.sequence[0]].from : bases[0];
  const wardrobeBase = bases.find((l) => state.choom.looks[l].wardrobe) || home;
  const was = $('#outfitBase').value;
  $('#outfitBase').replaceChildren(...bases.map((l) => el('option', { value: l, selected: l === (was || wardrobeBase) }, l)));
  if (!$('#outfitWhen').options.length) $('#outfitWhen').replaceChildren(...Object.entries(WHEN).map(([k, v]) => el('option', { value: k }, v)));
  updateOutfitForm();
}
['outfitBase', 'outfitWhen', 'outfitName', 'outfitWearing'].forEach((id) => $(`#${id}`).addEventListener('input', updateOutfitForm));
$('#outfitKind').addEventListener('input', () => { promptEdited = false; updateOutfitForm(); });
$('#outfitPrompt').addEventListener('input', () => { promptEdited = true; });
$('#outfitMake').addEventListener('click', attempt(async () => {
  if (outfitKind() === 'outfit' && !$('#outfitWearing').value.trim() && !promptEdited) return toast('Say what she wears', true);
  state.choom = (await api(`/api/choom/${state.cid}/outfit`, {
    kind: outfitKind(), base: $('#outfitBase').value, when: $('#outfitWhen').value, name: $('#outfitName').value,
    wearing: $('#outfitWearing').value, prompt: $('#outfitPrompt').value, count: Number($('#outfitCount').value),
  })).choom;
  promptEdited = false;
  $('#outfitWearing').value = ''; $('#outfitName').value = '';
  toast('Klein is making the pictures; they show up here when done (after any render ahead of it)');
  renderLooks();
  pollJobs();
}));

function renderDrafts() {
  const drafts = state.choom.drafts || {};
  $('#drafts').replaceChildren(...Object.entries(drafts).map(([look, d]) => el('section', { className: 'draft' },
    el('h3', {}, look),
    el('p', { className: 'muted' }, d.wearing ? `She wears ${d.wearing}. ` : '', d.status === 'making' ? 'Klein is making the pictures\u2026'
      : d.status === 'failed' ? 'Klein failed; see the work list.' : 'Pick the one that keeps her most herself.'),
    el('div', { className: 'pics' }, ...(d.pictures || []).map((f) => el('figure', {},
      el('img', { src: draftUrl(f), alt: `${look} version`, loading: 'lazy', onclick: () => { $('#zoomImg').src = draftUrl(f); $('#zoom').showModal(); } }),
      el('button', {
        className: 'ghost', type: 'button', onclick: attempt(async () => {
          state.choom = (await api(`/api/choom/${state.cid}/adopt`, { look, picture: f })).choom;
          toast(`${look} is a look now: plan its clips in Plan & render`);
          renderLooks();
        }),
        tip: 'Make this version the look',
      }, 'Use this one')))),
    el('div', { className: 'row' }, el('button', {
      className: 'ghost', type: 'button', onclick: attempt(async () => {
        state.choom = (await api(`/api/choom/${state.cid}/discard`, { look })).choom;
        renderLooks();
      }),
      tip: 'Throw these versions away (the files stay in clean/drafts)',
    }, 'Discard')))));
}
$('#zoom').addEventListener('click', () => $('#zoom').close());

// --- A new Choom -----------------------------------------------------------------------------------
$('#newChoomButton').addEventListener('click', () => {
  if (!$('#ncPrompt').value) $('#ncPrompt').value = state.cleanPrompt || '';
  $('#newChoom').showModal();
});
$('#ncClean').addEventListener('change', () => { $('#ncPrompt').disabled = !$('#ncClean').checked; });
$('#ncCreate').addEventListener('click', attempt(async () => {
  const name = $('#ncName').value.trim();
  const file = $('#ncPicture').files[0];
  if (!name || !file) return toast('Give her name and a picture', true);
  const picture = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('could not read the picture'));
    r.readAsDataURL(file);
  });
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  await api('/api/new-choom', {
    id, name, color: $('#ncColor').value, style: $('#ncStyle').value, picture, who: $('#ncWho').value,
    clean: $('#ncClean').checked, prompt: $('#ncPrompt').value,
  });
  $('#newChoom').close();
  state.tab = 'looks';
  state.cid = id;
  await loadChooms();
  toast($('#ncClean').checked ? `Klein is cleaning up ${name}'s picture; pick one under Looks` : `${name} is in the Studio`);
  pollJobs();
}));

// --- Jobs -----------------------------------------------------------------------------------------
const STATE_WORDS = { waiting: 'waiting', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' };
async function pollJobs() {
  try {
    const was = state.jobs.filter((j) => j.status === 'running');
    const before = was.map((j) => j.id).join() + `:${was.find((j) => j.kind === 'render')?.progress?.done ?? ''}`;
    state.jobs = (await api('/api/jobs')).jobs;
    const running = state.jobs.filter((j) => j.status === 'running');
    const waiting = state.jobs.filter((j) => j.status === 'waiting');
    const pill = $('#jobsButton');
    const r = running.find((j) => j.kind === 'render');
    const lastFailed = state.jobs.length && state.jobs[state.jobs.length - 1].status === 'failed';
    pill.className = `jobs-pill${running.length ? ' busy' : lastFailed ? ' failed' : ''}`;
    $('#jobsText').textContent = r ? `Rendering ${r.progress?.done ?? 0}/${r.progress?.total || r.args.clips}`
      : running.length ? `${running[0].kind === 'build' ? 'Building' : 'Checking'}…`
        : waiting.length ? `${waiting.length} waiting` : lastFailed ? 'Last job failed' : 'Idle';
    renderJobs();
    // Refresh her clips when work starts or ends, or when a render lands another clip.
    const after = running.map((j) => j.id).join() + `:${r?.progress?.done ?? ''}`;
    if (before !== after && state.cid) await refresh();
  } catch { /* the server may be restarting */ }
}
setInterval(pollJobs, 8000);

function renderJobs() {
  $('#jobsList').replaceChildren(...[...state.jobs].reverse().slice(0, 15).map((j) => {
    const p = j.progress || {};
    const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
    const what = j.kind === 'render' ? `${j.args.clips} clips (${j.args.queue})` : j.args.choom || '';
    const when = j.status === 'waiting' && j.not_before > Date.now() / 1000
      ? ` at ${new Date(j.not_before * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    return el('div', { className: `job ${j.status}` },
      el('div', { className: 'row' }, el('span', {}, el('span', { className: 'kind' }, j.kind), ` ${what}`),
        el('span', { className: 'state' }, `${STATE_WORDS[j.status]}${when}${j.status === 'running' && p.total ? ` · ${p.done}/${p.total} ${p.step || ''}` : ''}`)),
      j.kind === 'render' && j.status === 'running' ? el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })) : null,
      j.error ? el('div', { className: 'state' }, j.error) : null,
      j.log?.length && j.status !== 'done' ? el('pre', {}, j.log.slice(-8).join('\n')) : null,
      ['waiting', 'running'].includes(j.status) ? el('div', {}, el('button', {
        className: 'ghost', type: 'button', onclick: attempt(async () => { await api(`/api/jobs/${j.id}/cancel`, {}); pollJobs(); }),
        tip: j.kind === 'render' ? 'Stop Wan2GP; clips not rendered yet go back to planned' : 'Cancel this job',
      }, 'Cancel')) : null);
  }));
  if (!state.jobs.length) $('#jobsList').replaceChildren(el('p', { className: 'muted' }, 'No work yet.'));
}
$('#jobsButton').addEventListener('click', () => { $('#jobsPanel').hidden = !$('#jobsPanel').hidden; renderJobs(); });
$('#jobsClose').addEventListener('click', () => { $('#jobsPanel').hidden = true; });

// --- Tooltips -------------------------------------------------------------------------------------
let tipTimer = null;
let tipFor = null;
function showTip(target) {
  const tip = $('#tip');
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
  let y = r.bottom + 8;
  if (y + t.height > window.innerHeight - 8) y = r.top - t.height - 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { clearTimeout(tipTimer); tipFor = null; $('#tip').hidden = true; }
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target === tipFor) return;
  hideTip();
  if (!target) return;
  tipFor = target;
  tipTimer = setTimeout(() => showTip(target), 450);
});
document.addEventListener('focusin', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target && target.matches(':focus-visible')) { tipFor = target; showTip(target); }
});
['mousedown', 'scroll', 'keydown', 'focusout', 'dragstart'].forEach((ev) => document.addEventListener(ev, hideTip, true));

// A changed address (a link, back and forward) opens that view.
window.addEventListener('hashchange', () => {
  const was = { cid: state.cid, tab: state.tab, f: state.reviewFilter };
  fromHash();
  if (was.cid !== state.cid) openChoom(state.cid).catch((e) => toast(e.message, true));
  else if (was.tab !== state.tab || was.f !== state.reviewFilter) render();
});

loadChooms().catch((e) => { $('#intro').textContent = `Couldn’t reach the Studio: ${e.message}`; });
pollJobs();
