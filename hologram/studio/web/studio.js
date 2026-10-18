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
// POSTs started and finished: a background refresh that began before one of them changes is stale (its
// answer could bring a kept clip back under To review), so it's dropped.
let writes = 0;
const api = async (path, body) => {
  const post = body !== undefined;
  if (post) writes++;
  try {
    const r = await fetch(path, post ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  } finally {
    if (post) writes++;
  }
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

async function openChoom(cid, keepScroll = false, background = false) {
  state.cid = cid;
  remember();
  const y = window.scrollY;
  const w = writes;
  const data = await api(`/api/choom/${cid}`);
  if (background && (w !== writes || cid !== state.cid)) return;  // an action answered meanwhile, with newer data
  state.choom = data;
  document.documentElement.style.setProperty('--tint', state.choom.color || '#9fb4ff');
  $$('#chooms button').forEach((b) => b.classList.toggle('on', b.dataset.id === cid));
  // Her tab counts what her glass plays now (it changes when a build lands, not when clips are placed).
  const { sequence, glass } = state.choom;
  const tab = $(`#chooms button[data-id="${cid}"] small`);
  if (tab) tab.textContent = `${sequence.length - glass.added.length + glass.removed.length}`;
  $('#intro').hidden = true;
  $('#choom').hidden = false;
  if (background && paneBusy()) {  // he's typing: the pane waits (renderLater), the header shows it's behind
    state.renderLater = true;
    renderHead();
    return;
  }
  state.renderLater = false;
  render();
  if (keepScroll) window.scrollTo(0, y);
}
// A background refresh (work started or ended, a clip landed): it never rebuilds a pane he's typing in.
const refresh = attempt(async () => { await openChoom(state.cid, true, true); });

// Fields the page rebuilds (look cards, Review notes, planned-clip edits): while one has focus or holds
// unsaved text, a background refresh leaves the pane alone and catches up when he leaves the field or
// saves, instead of wiping what he's writing.
const REBUILT = '#reviewGrid, #planned, #looksGrid, #drafts, #wishes, #library, #renderBox, #glassLooks';
const TEXTY = 'textarea, select, input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="time"]';
function paneBusy() {
  const pane = $(`.pane[data-pane="${state.tab}"]`);
  const live = (e) => !!(e && e.closest?.(REBUILT) && pane?.contains(e));
  const a = document.activeElement;
  return (a?.matches?.(TEXTY) && live(a)) || $$('[data-dirty]', pane || document).some(live);
}
document.addEventListener('input', (e) => { if (e.target.matches?.(TEXTY) && e.target.closest(REBUILT)) e.target.dataset.dirty = '1'; }, true);
document.addEventListener('focusout', () => setTimeout(renderLater, 0));
function renderLater() {
  if (!state.renderLater || paneBusy()) return;
  const y = window.scrollY;
  state.renderLater = false;
  render();
  window.scrollTo(0, y);
}
// Saved: its fields hold what the server has now, so they no longer hold back a refresh.
function markClean(root) {
  $$('[data-dirty]', root).forEach((e) => { delete e.dataset.dirty; });
  setTimeout(renderLater, 0);
}

function renderHead() {
  const c = state.choom;
  const counts = Object.values(c.clips).reduce((a, k) => ({ ...a, [k.status]: (a[k.status] || 0) + 1 }), {});
  $('#choomName').textContent = c.name;
  $('#choomLine').textContent = [
    c.glass.added.length || c.glass.removed.length
      ? `${c.sequence.length - c.glass.added.length + c.glass.removed.length} clips on the glass (${c.sequence.length} once built)`
      : `${c.sequence.length} clips on the glass`, `${Object.keys(c.looks).length} looks`,
    counts.rendered ? `${counts.rendered} to review` : null, counts.planned ? `${counts.planned} planned` : null,
    counts.queued ? queuedSummary(c) : null,
    state.renderLater ? 'newer changes show when you leave the field you’re editing or save it' : null,
  ].filter(Boolean).join(' · ');
}

function render() {
  renderHead();
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== state.tab; });
  const done = ({ review: renderReview, glass: renderGlass, plan: renderPlan, looks: renderLooks })[state.tab]();
  done?.catch?.((e) => toast(e.message, true));
}

$$('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; remember(); render(); }));

// --- Review ---------------------------------------------------------------------------------------
function lookOptions(select, value, withAll) {
  const looks = lookOrder(state.choom.looks);
  select.replaceChildren(...(withAll ? [el('option', { value: '' }, 'All looks')] : []),
    ...looks.map((l) => el('option', { value: l, selected: l === value }, l)));
}

function renderReview() {
  // A refresh while he goes through cards with the keyboard keeps the card he's on.
  const focused = document.activeElement?.closest?.('#reviewGrid .card')?.dataset.name;
  fillReview();
  if (focused) focusCard(focused);
}

function fillReview() {
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
  // After a decision the grid is rebuilt; the keyboard stays on the next card (or this one, if it's
  // still shown), found by clip name, so K, D and R can follow one after another.
  const after = (keep) => {
    const next = card.nextElementSibling?.dataset.name || card.previousElementSibling?.dataset.name;
    render();
    focusCard(keep && $(`#reviewGrid .card[data-name="${CSS.escape(name)}"]`) ? name : next);
  };
  const decide = attempt(async (status) => {
    state.choom = (await api(`/api/choom/${cid}/status`, { names: [name], status, note: note.value })).choom;
    toast(`${short(cid, name)}: ${status}`);
    after(!(['rendered', 'flagged'].includes(state.reviewFilter) && status !== 'rendered'));
  });
  const reroll = attempt(async () => {
    state.choom = (await api(`/api/choom/${cid}/reroll`, { names: [name] })).choom;
    toast(`${short(cid, name)} planned again with a new seed; render it from Plan & render`);
    after(false);
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
      takesRow(name),
      el('div', { className: 'card-buttons' },
        el('button', { className: 'keep', type: 'button', onclick: () => decide('kept'), tip: 'Keep it (K): it can go on the glass' }, 'Keep'),
        el('button', { className: 'drop', type: 'button', onclick: () => decide('dropped'), tip: 'Drop it (D): it stays in her project, off the glass' }, 'Drop'),
        el('button', { type: 'button', onclick: reroll, tip: 'Re-roll (R): plan it again with a new seed (edit the wording first if you like); the old take is kept' }, 'Re-roll'),
        note)));
  card.dataset.name = name;
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

// Earlier takes of a re-rolled clip whose files are still in clips/takes/: watch one, or bring it back
// (project.use_take: it becomes the clip again, with its seed, status and note; the one it replaces
// becomes a take; its sheet is made again).
function takesRow(name) {
  const c = state.choom.clips[name];
  const takes = state.choom.takes?.[name] || [];
  if (!takes.length || !['rendered', 'kept', 'dropped'].includes(c.status)) return null;
  const cid = state.cid;
  return el('div', { className: 'takes' }, el('span', { className: 'muted' }, 'Earlier takes:'),
    ...takes.map(([i, file]) => {
      const h = c.history[i] || {};
      const label = `take ${i + 1}${h.status ? ` (${h.status})` : ''}`;
      return el('span', { className: 'take' },
        el('button', { className: 'ghost small', type: 'button', onclick: () => play(name, `/media/take/${encodeURIComponent(file)}`, `${short(cid, name)}, ${label}`), tip: `Watch ${label}${h.note ? `: ${h.note}` : ''}` }, `▶ ${label}`),
        el('button', {
          className: 'ghost small', type: 'button', tip: `Make ${label} the clip again (seed ${h.seed ?? '?'}); the take you have now goes to the earlier takes`,
          onclick: attempt(async () => {
            const r = await api(`/api/choom/${cid}/take`, { name, index: i });
            state.choom = r.choom;
            toast(`${short(cid, name)}: ${label} is back (${r.status}); its sheet is being made again`);
            render();
            focusCard(name);
          }),
        }, 'Use it'));
    }));
}

function focusCard(name) {
  const card = name && $(`#reviewGrid .card[data-name="${CSS.escape(name)}"]`);
  if (card) card.focus();
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

function play(name, url = clipUrl(name), label = name) {
  const v = $('#playerVideo');
  v.src = url;
  $('#playerName').textContent = label;
  $('#player').showModal();
  v.play().catch(() => {});
}
$('#playerClose').addEventListener('click', () => $('#player').close());
$('#player').addEventListener('close', () => { const v = $('#playerVideo'); v.pause(); v.removeAttribute('src'); v.load(); });

// --- On the glass (drag and drop) -----------------------------------------------------------------
// Her looks in a sensible order: main, relaxed, outfits, full body (hers, then her outfits'), asleep.
const rank = (l) => (l === 'main' ? 0 : l === 'relaxed' ? 1 : l === 'full' ? 3 : l.startsWith('full@') ? 3.5 : l === 'asleep' ? 4 : 2);
const lookOrder = (looks) => Object.keys(looks).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

function renderGlass() {
  const c = state.choom;
  const bar = $('#buildBar');
  const { added, removed } = c.glass;
  const building = state.jobs.some((j) => j.kind === 'build' && j.status === 'running' && j.args.choom === state.cid);
  const changes = (added.length || removed.length
    ? `Not built yet: ${added.length} to add, ${removed.length} to take off.`
    : 'The glass shows this sequence.')
    + (building ? ' A build is running now; changes made since it started go in with the next one.' : '');
  const build = el('button', { className: 'primary', type: 'button', disabled: !!c.problems.length || !(added.length || removed.length), tip: 'Cut-outs, depth and reliefs for new clips (only new ones are encoded), then the glass reloads once nobody is talking' },
    'Build and put on the glass');
  const startBuild = (body) => attempt(async () => {
    const r = await api('/api/build', { choom: state.cid, ...body });
    const j = r.job;
    const when = j.after ? 'after the render' : j.not_before > Date.now() / 1000 ? `at ${clock(j.not_before)}` : '';
    toast(r.already ? `A build for her is already waiting${when ? ` (now ${when})` : ''}; it reads her sequence when it starts, so it includes this`
      : when ? `Build scheduled ${when}; it reads her sequence when it starts`
        : startWords(r, 'Building: cut-outs, depth and reliefs for the new clips, then the glass reloads when she is quiet'));
    pollJobs();
  })();
  build.addEventListener('click', () => startBuild({}));
  const buildAt = el('input', { type: 'time', value: '23:00', tip: 'Build at this time' });
  const renderAhead = state.jobs.some((j) => j.kind === 'render' && ['waiting', 'running', 'paused'].includes(j.status));
  const buildBox = el('div', { className: 'build-actions' }, build,
    el('div', { className: 'row' },
      el('span', { className: 'muted' }, 'or at'), buildAt,
      el('button', { className: 'ghost', type: 'button', disabled: !!c.problems.length, tip: 'Build at this time (tonight, say); the GPU takes turns, so it waits for any render running then', onclick: () => {
        const [h, m] = buildAt.value.split(':').map(Number);
        const t = new Date(); t.setHours(h, m, 0, 0);
        if (t < new Date()) t.setDate(t.getDate() + 1);
        startBuild({ at: Math.round(t / 1000) });
      } }, 'Schedule'),
      renderAhead ? el('button', { className: 'ghost', type: 'button', disabled: !!c.problems.length, tip: 'Build as soon as the render waiting or running now has finished', onclick: () => startBuild({ after: 'render' }) }, 'After the render') : null));
  const scheduled = state.jobs.find((j) => j.kind === 'build' && j.status === 'waiting' && j.args.choom === state.cid);
  const home = c.looks.relaxed ? el('label', { className: 'muted home-pose', tip: 'The pose she falls asleep from, wakes into and changes clothes in (Aloy keeps her hand down: relaxed). Clips planned from now on take it; built clips at the next build' },
    'Home pose ', el('select', { onchange: attempt(async (e) => {
      state.choom = (await api(`/api/choom/${state.cid}/home`, { pose: e.target.value })).choom;
      toast(`Her home pose is ${e.target.value}; build to put it on the glass`);
    }) }, ...['main', 'relaxed'].map((v) => el('option', { value: v, selected: (c.home || 'main') === v }, v)))) : null;
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
      ...readinessWarnings(),
      scheduled ? el('div', { className: 'muted' }, `A build is waiting${scheduled.after ? ' for the render to finish' : scheduled.not_before > Date.now() / 1000 ? ` for ${clock(scheduled.not_before)}` : ' for the GPU'}.`) : null,
      c.built ? el('div', { className: 'muted' }, `Last built ${c.built.time.replace('T', ' ')} (${c.built.clips} clips, ${c.built.minutes} min)`) : null,
      home),
    buildBox);

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
        readinessLine(look),
        allOn),
      el('div', { className: 'lane-label' }, 'On the glass'),
      lane(look, on, true),
      el('div', { className: 'lane-label' }, `Kept, not on the glass (${off.length})`),
      lane(look, off, false));
  }));
}

// How far a look and its outfit are from the glass (project.readiness): kept clips never put on the
// glass, an outfit's full body that can't play because she can't wear the outfit yet, and what a build
// still has to make.
function readinessWarnings() {
  const r = state.choom.readiness;
  if (!r) return [];
  return r.warnings.map((w) => {
    const look = w.split(':')[0];
    const n = r.looks[look];
    const fix = n && n.kept && !n.placed ? el('button', {
      className: 'ghost small', type: 'button', tip: `Put all ${n.kept} kept clips of ${look} on the glass (then build)`,
      onclick: attempt(async () => { await placeAll(look); }),
    }, 'Put them on the glass') : null;
    return el('div', { className: 'problem' }, w, fix ? ' ' : null, fix);
  });
}
async function placeAll(look) {
  const c = state.choom;
  const off = Object.keys(c.clips).filter((n) => c.clips[n].from === look && c.clips[n].status === 'kept' && !c.sequence.includes(n));
  state.choom = (await api(`/api/choom/${state.cid}/place`, { names: off, on: true })).choom;
  toast(`${off.length} clips of ${look} added; build to put them on the glass`);
  render();
}
function readinessLine(look) {
  const r = state.choom.readiness;
  if (!r) return null;
  const n = r.looks[look] || { kept: 0, placed: 0, unbuilt: 0 };
  const o = look.split('@')[1];
  const outfit = o && r.outfits[o];
  const bits = [`${n.kept} kept`, `${n.placed} placed`];
  if (n.unbuilt) bits.push(`${n.unbuilt} not built yet`);
  if (outfit && waistUp(look)) bits.push(outfit.talk ? 'has a talk loop' : 'no talk loop placed: she can’t wear it yet');
  if (outfit && waistUp(look) && outfit.unbuilt) bits.push(`about ${outfit.buildMinutes} min to build its ${outfit.unbuilt} new clips`);
  return el('span', { className: `stat ready${outfit && waistUp(look) && !outfit.talk ? ' warn' : ''}`, tip: o
    ? `The outfit ${o}: the glass puts her in it only once a loop she can talk over (Essentials) of ${look} is built, and plays its full body and asleep look only while she wears it`
    : 'Kept clips of this look, how many are placed on the glass, and how many a build still has to make' }, bits.join(' · '));
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
  // A tap instead of a drag (a phone or tablet has no drag and drop here): + puts it on, − takes it off.
  if (!main) {
    t.append(el('button', {
      className: 'flip', type: 'button', 'aria-label': on ? 'Take it off the glass' : 'Put it on the glass',
      tip: on ? 'Take it off the glass' : 'Put it on the glass', textContent: on ? '−' : '+',
      onclick: attempt(async (e) => {
        e.stopPropagation();
        state.choom = (await api(`/api/choom/${state.cid}/place`, { names: [name], on: !on })).choom;
        toast(`${short(state.cid, name)} ${on ? 'off' : 'on'} the glass; build to make it so`);
        renderGlass();
      }),
    }));
  }
  return t;
}

// --- Plan & render --------------------------------------------------------------------------------
renderPlan.seq = 0;
async function renderPlan() {
  const seq = ++renderPlan.seq;  // switching looks quickly: only the latest answer fills the library
  const c = state.choom;
  state.planLook = state.planLooks[state.cid];
  if (!state.planLook || !c.looks[state.planLook]) state.planLook = c.sequence.length ? c.clips[c.sequence[0]].from : Object.keys(c.looks)[0];
  lookOptions($('#planLook'), state.planLook, false);
  renderChangeForm();
  const look = c.looks[state.planLook];
  $('#planLookInfo').textContent = look.picture ? `starts and ends on ${look.picture}` : 'this look has no picture yet';
  renderWishes();
  const [{ options }, { packs }] = await Promise.all([api(`/api/options/${state.cid}/${encodeURIComponent(state.planLook)}`), api('/api/packs')]);
  if (seq !== renderPlan.seq) return;
  state.options = options;
  renderLibrary(packs);
  renderPlanned();
}

// Her wishes: what she asked the glass for (glass_move, glass_wear, glass_wish) and hasn't got yet, and
// folded away below, the ones that came true.
function renderWishes() {
  const c = state.choom;
  const done = c.wishesDone || [];
  if (!c.wishes?.length && !done.length) return $('#wishes').replaceChildren();
  const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const settle = (w, made) => attempt(async () => {
    state.choom = (await api(`/api/choom/${state.cid}/wish`, { kind: w.kind, what: w.what, made })).choom;
    toast(made ? `“${w.what}” is on her list of wishes that came true` : `“${w.what}” is off her list`);
    renderWishes();
  });
  $('#wishes').replaceChildren(el('div', { className: 'wishes' },
    el('h3', {}, `${c.name}'s wishes`),
    el('p', { className: 'hint' }, 'What she asked the glass for and hasn\'t got yet. Once it\'s made she can ask for it by name. Mark a wish made when it\'s on the glass, or let it go if it won\'t be.'),
    ...(c.wishes || []).map((w) => el('div', { className: 'wish' },
      el('span', {}, el('b', {}, `“${w.what}”`), ` ${w.kind === 'wear' ? 'to wear' : 'a move'} · asked ${w.times > 1 ? `${w.times} times, last ` : ''}${day(w.last)}`),
      w.kind === 'wear'
        ? el('button', { type: 'button', className: 'ghost', onclick: () => wishOutfit(w), tip: 'Start a new outfit with this as what she wears' }, 'New outfit')
        : el('button', { type: 'button', className: 'ghost', onclick: () => wishMove(w), tip: 'Write it as your own clip: a move that ends where it began (sitting down or leaving need new poses, not yet)' }, 'Write it'),
      el('button', { type: 'button', className: 'ghost', onclick: settle(w, true), tip: 'It\'s made: off her list, onto the list of wishes that came true' }, 'Made it'),
      el('button', { type: 'button', className: 'ghost', onclick: settle(w, false), tip: 'It won\'t be made: take it off her list' }, 'Let go'))),
    done.length ? el('details', { className: 'wishes-done' },
      el('summary', {}, `Wishes that came true (${done.length})`),
      ...[...done].reverse().map((w) => el('div', { className: 'wish' },
        el('span', {}, el('b', {}, `“${w.what}”`), ` ${w.kind === 'wear' ? 'to wear' : 'a move'} · asked ${day(w.first || w.last)}, made ${day(w.made)}`)))) : null));
}
function wishMove(w) {
  $('#customClip').open = true;
  $('#customKey').value = w.what.toLowerCase().replace(/^(a|an|the|some|my)\s+/, '').replace(/[^a-z0-9]/g, '').slice(0, 16);
  $('#customClip').scrollIntoView({ block: 'center' });
  $('#customText').focus();
}
function wishOutfit(w) {
  state.tab = 'looks'; remember(); render();
  $('#newOutfit').open = true;
  $('#outfitKind').value = 'outfit';
  $('#outfitKind').dispatchEvent(new Event('input'));
  $('#outfitWearing').value = w.what.replace(/^(my|a|an|the|some)\s+/i, '');
  updateOutfitForm();
  $('#newOutfit').scrollIntoView({ block: 'start' });
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

// A change of clothes on screen: from one of her waist-up looks to another.
function renderChangeForm() {
  const looks = lookOrder(state.choom.looks).filter((l) => waistUp(l) && state.choom.looks[l].picture);
  for (const [id, pick] of [['changeFrom', waistUp(state.planLook) ? state.planLook : looks[0]], ['changeTo', looks[1]]]) {
    const was = $(`#${id}`).value;
    $(`#${id}`).replaceChildren(...looks.map((l) => el('option', { value: l, selected: l === (looks.includes(was) ? was : pick) }, l)));
  }
}
$('#changeAdd').addEventListener('click', attempt(async () => {
  const text = $('#changeText').value.trim();
  if (!text) return toast('Say what happens as she changes', true);
  const { results, choom } = await api(`/api/choom/${state.cid}/change`, {
    from: $('#changeFrom').value, to: $('#changeTo').value, text, seconds: Number($('#changeSeconds').value),
    key: $('#changeKey').value.trim().toLowerCase().replace(/[^a-z0-9]/g, ''),
  });
  state.choom = choom;
  const [name, message] = results[0];
  toast(`${short(state.cid, name)} planned${message !== 'ok' ? ` (check: ${message})` : ''}`);
  $('#changeKey').value = ''; $('#changeText').value = '';
  render();
}));

// --- Plan for many looks at once ------------------------------------------------------------------
// Library actions for many looks in one step (Expressions and Oops for every outfit): tick actions and
// looks, preview what each look gets and how long it renders, then plan. plan.many on the server skips
// what a look already has, so planning twice never makes numbered copies.
const many = { packs: null, actions: [], looks: {}, picked: new Set(), targets: new Set(), preview: null };
const manyKey = (cid, look) => `${cid}|${look}`;
const outfitLook = (l) => l.includes('@') && waistUp(l);
$('#manyPlan').addEventListener('toggle', attempt(async () => { if ($('#manyPlan').open) await renderMany(true); }));
async function renderMany(reload = false) {
  if (!many.packs || reload) {
    const lib = await api('/api/packs');
    many.packs = lib.packs;
    many.actions = lib.actions || [];
    const chooms = await Promise.all(state.chooms.map((c) => api(`/api/choom/${c.id}`)));
    many.looks = Object.fromEntries(chooms.map((d) => [d.id, lookOrder(d.looks)]));
    many.names = Object.fromEntries(chooms.map((d) => [d.id, d.name]));
  }
  const changed = () => { many.preview = null; renderMany(); };
  // Actions, pack by pack: the pack's box ticks all of it.
  $('#manyPacks').replaceChildren(...many.packs.map((p) => {
    const acts = many.actions.filter((a) => a.pack === p.id);
    const ids = acts.map((a) => `${a.pack}|${a.key}`);
    const all = el('input', { type: 'checkbox', checked: ids.length && ids.every((i) => many.picked.has(i)) });
    all.indeterminate = !all.checked && ids.some((i) => many.picked.has(i));
    all.addEventListener('change', () => { ids.forEach((i) => (all.checked ? many.picked.add(i) : many.picked.delete(i))); changed(); });
    return el('details', { className: 'many-pack', open: ids.some((i) => many.picked.has(i)) },
      el('summary', {}, el('label', { onclick: (e) => e.stopPropagation() }, all, ` ${p.title}`), el('small', { className: 'muted' }, ` ${acts.length}`)),
      ...acts.map((a) => {
        const id = `${a.pack}|${a.key}`;
        const box = el('input', { type: 'checkbox', checked: many.picked.has(id) });
        box.addEventListener('change', () => { box.checked ? many.picked.add(id) : many.picked.delete(id); changed(); });
        return el('label', { className: 'many-act', tip: a.text }, box, ` ${a.key}`, el('small', { className: 'muted' }, ` ${a.seconds} s`));
      }));
  }));
  // Looks, Choom by Choom, with quick picks for outfits.
  const pickLooks = (fn) => () => { many.targets.clear(); for (const [cid, looks] of Object.entries(many.looks)) looks.filter((l) => fn(cid, l)).forEach((l) => many.targets.add(manyKey(cid, l))); changed(); };
  $('#manyQuick').replaceChildren(
    el('button', { className: 'ghost small', type: 'button', onclick: pickLooks((cid, l) => cid === state.cid && outfitLook(l)), tip: `Every outfit of ${state.choom.name}'s, waist up` }, `${state.choom.name}'s outfits`),
    el('button', { className: 'ghost small', type: 'button', onclick: pickLooks((cid, l) => outfitLook(l)), tip: 'Every waist-up outfit of every Choom' }, "Every Choom's outfits"),
    el('button', { className: 'ghost small', type: 'button', onclick: pickLooks(() => false) }, 'None'));
  $('#manyLooks').replaceChildren(...Object.entries(many.looks).map(([cid, looks]) => el('div', { className: 'many-choom' },
    el('b', {}, many.names[cid] || cid),
    el('div', { className: 'many-chips' }, ...looks.map((l) => {
      const box = el('input', { type: 'checkbox', checked: many.targets.has(manyKey(cid, l)) });
      box.addEventListener('change', () => { box.checked ? many.targets.add(manyKey(cid, l)) : many.targets.delete(manyKey(cid, l)); changed(); });
      return el('label', { className: 'chip-check' }, box, ` ${l}`);
    })))));
  // What it would plan.
  const body = () => ({ targets: [...many.targets].map((k) => k.split('|')), items: [...many.picked].map((k) => k.split('|')) });
  const preview = el('button', {
    type: 'button', disabled: !many.targets.size || !many.picked.size, tip: 'Show what each look gets, before anything is planned',
    onclick: attempt(async () => { many.preview = await api('/api/plan-many', { ...body(), preview: true }); renderMany(); }),
  }, 'Preview');
  const p = many.preview;
  const hours = (m) => (m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
  const go = p && p.clips ? el('button', {
    className: 'primary', type: 'button', tip: 'Plan them all; render from the Planned list of each Choom (or Render now / Schedule there)',
    onclick: attempt(async () => {
      const r = await api('/api/plan-many', { ...body(), preview: false });
      const skipped = r.results.filter(([, n]) => !n);
      toast(`${r.results.length - skipped.length} clips planned in ${r.looks.filter((e) => e.plan.length).length} looks${skipped.length ? `; ${skipped.length} skipped` : ''}`, !!skipped.length);
      await refresh();
      many.preview = await api('/api/plan-many', { ...body(), preview: true });
      renderMany();
    }),
  }, `Plan ${p.clips} clips`) : null;
  $('#manyPreview').replaceChildren(...[el('div', { className: 'row' }, preview, go,
    p ? el('span', { className: 'muted' }, p.clips ? `${p.clips} clips · about ${hours(p.minutes)} of rendering` : 'Nothing new to plan: they have these already') : el('span', { className: 'muted' }, `${many.picked.size} actions × ${many.targets.size} looks ticked`)),
    p ? el('div', { className: 'many-table' }, ...p.looks.map((e) => el('div', { className: 'many-row' },
      el('span', {}, el('b', {}, many.names[e.choom] || e.choom), ` ${e.look}`),
      el('span', { tip: e.plan.map((n) => short(e.choom, n)).join(', ') }, e.plan.length ? `${e.plan.length} to plan` : 'nothing new'),
      el('span', { className: 'muted', tip: e.have.map((n) => short(e.choom, n)).join(', ') }, e.have.length ? `has ${e.have.length}` : ''),
      e.blocked.length ? el('span', { className: 'problem', tip: e.blocked.join('\n') }, `${e.blocked.length} need a picture first`) : el('span', {})))) : null].filter(Boolean));
}

function renderPlanned() {
  const c = state.choom;
  const planned = Object.keys(c.clips).filter((n) => c.clips[n].status === 'planned');
  const queued = Object.keys(c.clips).filter((n) => c.clips[n].status === 'queued');
  const list = $('#planned');
  list.replaceChildren(
    ...(planned.length ? planned.map(plannedItem) : [el('p', { className: 'muted' }, 'Nothing planned. Pick actions on the left.')]),
    queued.length ? el('p', { className: 'muted' }, queuedSummary(c)) : null);
  const minutes = Math.round(planned.reduce((a, n) => a + state.minutesPerClip * (c.clips[n].frames || 124) / 124, 0));
  const box = $('#renderBox');
  if (!planned.length) { box.replaceChildren(); return; }
  const when = el('input', { type: 'time', value: '23:00' });
  const go = (at) => attempt(async () => {
    const r = await api('/api/render', { chooms: [state.cid], at });
    toast(at ? `Queued for ${clock(at)}` : startWords(r, 'Rendering started'));
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
  // A re-roll can be longer too (a full turn that came out rushed in five seconds).
  const length = el('select', { tip: 'How long the clip is; longer clips take longer to render' },
    ...[5, 6, 7, 10, 12, 15].map((s) => el('option', { value: s, selected: s === secondsOf(c) }, `${s} s`)));
  const editing = el('div', { hidden: true }, text,
    el('div', { className: 'row' }, length,
      el('button', {
        className: 'ghost', type: 'button', onclick: attempt(async () => {
          state.choom = (await api(`/api/choom/${state.cid}/rewrite`, { name, text: text.value, seconds: Number(length.value) })).choom;
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
      el('button', { className: 'ghost', type: 'button', onclick: () => { editing.hidden = !editing.hidden; }, tip: 'Change what she does or how long it is; the prompt is rebuilt from her look' }, 'Edit'),
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
    // An outfit's closet words: what she can ask for it by (glass_wear). Sent only when changed, so
    // words read from her clothes keep following them.
    const words = look.includes('@') ? (c.closet?.[look] || []).join(', ') : null;
    const closet = words === null ? null : el('input', { value: words });
    // What she wears in an outfit: the Subject's clothes follow it when it changes (server side), and an
    // outfit's full body made later starts from it. Sent only when changed.
    const wears = look.includes('@') ? el('input', { value: l.wearing || '', placeholder: 'read from the Subject until set' }) : null;
    // What Klein keeps of her when a new look starts from this one (only waist-up looks are starting
    // points). Sent only when changed.
    const kleinKeep = waistUp(look) ? el('textarea', { rows: 2, value: l.kleinKeep || '', placeholder: 'her face, expression, hair and pose' }) : null;
    const save = el('button', {
      className: 'ghost', type: 'button', onclick: attempt(async () => {
        const wearsChanged = wears && wears.value.trim() !== (l.wearing || '');
        state.choom = (await api(`/api/choom/${state.cid}/look`, {
          look, subject: subject.value, keep: keep.value, ending: ending.value,
          ...(closet && closet.value !== words ? { tags: closet.value } : {}),
          ...(wearsChanged ? { wearing: wears.value } : {}),
          ...(kleinKeep && kleinKeep.value.trim() !== (l.kleinKeep || '') ? { kleinKeep: kleinKeep.value.trim().replace(/[,. ]+$/, '') } : {}),
        })).choom;
        const inQueue = Object.values(state.choom.clips).filter((k) => k.status === 'queued' && (k.from === look || k.to === look)).length;
        toast(`${look} saved; clips planned from now on use it` + (inQueue
          ? `. ${inQueue} of its clips are already queued to render and keep their old prompt (cancel that render and render again to use the new one)` : ''));
        if (wearsChanged) renderLooks(); // the Subject now names the new clothes
        else markClean(save.closest('.look-card'));
      }),
      tip: 'Save the look; clips planned from now on use it (rendered clips keep their prompts)',
    }, 'Save');
    const s = c.stats[look] || { onGlass: 0 };
    return el('article', { className: 'look-card' },
      l.picture ? el('img', { src: pictureUrl(l.picture), alt: `${c.name}, ${look}`, loading: 'lazy' }) : el('div', { className: 'empty' }, 'no picture'),
      el('div', {},
        el('h3', {}, look),
        el('p', { className: 'muted' }, `${l.picture || 'no picture'} · ${s.onGlass} clips on the glass`),
        el('p', {}, readinessLine(look), (c.readiness?.looks[look]?.kept && !c.readiness.looks[look].placed)
          ? el('button', { className: 'ghost small', type: 'button', onclick: attempt(() => placeAll(look)), tip: 'Put all its kept clips on the glass (then build)' }, 'Put them on the glass') : null),
        !l.picture && !(c.drafts || {})[look] ? firstPicture(look, l) : null,
        el('label', {}, 'Subject', subject),
        wears && el('label', { tip: 'What she wears in this look. Changing it puts the new clothes in the Subject (unless you edit the Subject too, then yours stands), and a full body of this outfit made later starts from it' }, 'She wears', wears),
        el('label', {}, 'Keep line', keep), el('label', {}, 'Loop ending', ending),
        kleinKeep ? el('label', { tip: 'What Klein keeps of her when a new look starts from this one (an outfit, its full body, her asleep): her face and what makes her herself, like Genesis\'s glasses and motes or Optic\'s headphones and heart. Outfits made from this look inherit it. A full body adds her clothes and leaves out her arms, hands and pose, since it stands relaxed' }, 'What Klein keeps', kleinKeep) : null,
        closet && el('label', { tip: 'Words she can ask for this outfit by (“my red dress”): the garment, its colour. Read from what she wears unless you change them; empty goes back to those' }, 'Closet words', closet),
        el('div', { className: 'row' }, save, ...lookTools(look))));
  }));
}

// Renaming an outfit (all its looks, clips and their files move; project.rename_outfit) and deleting a
// look (project.delete_look), each confirmed in the page first.
function lookTools(look) {
  const o = look.split('@')[1];
  return [
    o ? el('button', { className: 'ghost', type: 'button', onclick: attempt(() => renameOutfit(o)), tip: `Give the outfit ${o} a new name: its looks, clips and their files all move. The name starts with when she wears it (day, hot, evening, cold, night). Not while its clips are on the glass` }, 'Rename outfit') : null,
    look !== 'main' ? el('button', { className: 'ghost', type: 'button', onclick: attempt(() => deleteLook(look)), tip: 'Take this look out of her project (its picture file stays). Not while clips that aren\'t dropped use it' }, 'Delete look') : null,
  ].filter(Boolean);
}
async function renameOutfit(o) {
  const looks = Object.keys(state.choom.looks).filter((l) => l.split('@')[1] === o);
  const to = await ask({ title: `Rename the outfit ${o}`, text: `Its looks (${looks.join(', ')}), its clips and their files get the new name. It starts with when she wears it: day, hot, evening, cold or night.`, input: 'New name', value: o, ok: 'Rename' });
  if (!to || to === o) return;
  const r = await api(`/api/choom/${state.cid}/renameoutfit`, { from: o, to: to.trim().toLowerCase() });
  state.choom = r.choom;
  toast(`${o} is ${to} now: ${looks.length} looks and ${Object.keys(r.renamed).length} clips renamed`);
  render();
}
async function deleteLook(look) {
  if (!(await ask({ title: `Delete ${look}?`, text: 'It goes from her project; its picture file stays in clean/. Clips that use it have to be dropped (or removed from the plan) first.', ok: 'Delete', danger: true }))) return;
  let r;
  try {
    r = await api(`/api/choom/${state.cid}/deletelook`, { look });
  } catch (e) {
    if (!/dropped clip/.test(e.message)) throw e;
    if (!(await ask({ title: `Delete ${look} and its dropped clips?`, text: `${e.message}, with their history. Their files stay in clips/.`, ok: 'Delete both', danger: true }))) return;
    r = await api(`/api/choom/${state.cid}/deletelook`, { look, withDropped: true });
  }
  state.choom = r.choom;
  toast(`${look} deleted${r.deleted.length ? `, with ${r.deleted.length} dropped clip${r.deleted.length > 1 ? 's' : ''}` : ''}`);
  render();
}
// A question in the page (the browser's own confirm and prompt can't be styled or tested): resolves
// to true, the typed text, or null when cancelled.
function ask({ title, text, input, value = '', ok = 'OK', danger = false }) {
  const d = $('#askDialog');
  $('#askTitle').textContent = title;
  $('#askText').textContent = text || '';
  $('#askLabel').hidden = !input;
  $('#askInputName').textContent = input || '';
  $('#askInput').value = value;
  $('#askOk').textContent = ok;
  $('#askOk').classList.toggle('danger', danger);
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $('#askOk').onclick = $('#askCancel').onclick = d.onclose = null; resolve(v); };
    $('#askOk').onclick = () => done(input ? $('#askInput').value : true);
    $('#askCancel').onclick = () => done(null);
    d.onclose = () => resolve(null);
    $('#askInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#askOk').click(); } };
    d.showModal();
    (input ? $('#askInput') : $('#askOk')).focus();
  });
}

// A look with no picture and no versions waiting: a new Choom whose first Klein versions were all
// discarded. Every other way to make a picture starts from one she has, so Klein cleans up her source
// picture again, from the last prompt (change it first if those versions went wrong).
function firstPicture(look, l) {
  const prompt = el('textarea', { rows: 4, value: l.klein || state.cleanPrompt || '' });
  const count = el('select', {}, ...[2, 3, 4, 6].map((n) => el('option', { value: n, selected: n === 3 }, `${n} versions`)));
  return el('div', { className: 'first-picture' },
    el('p', { className: 'muted' }, 'She has no picture for this look yet. Klein can clean up her source picture again:'),
    el('label', {}, 'Klein prompt', prompt),
    el('div', { className: 'row' }, count, el('button', {
      type: 'button', onclick: attempt(async () => {
        state.choom = (await api(`/api/choom/${state.cid}/reclean`, { look, prompt: prompt.value, count: Number(count.value) })).choom;
        toast('Klein is making new versions from her source picture; they show up here when done');
        renderLooks();
        pollJobs();
      }),
      tip: 'Make new versions of her first picture from the picture you gave when you added her',
    }, 'Make pictures again')));
}

// --- New looks: outfits, full body, asleep, places (Klein), the empty glass -----------------------
const draftUrl = (f) => `/media/draft/${encodeURIComponent(f.replace(/^drafts\//, ''))}`;
const WHEN = { evening: 'evenings, 6 to 11 pm', cold: 'cold days (under 45°F)', hot: 'hot days (over 85°F)', day: 'daytime, taking turns with her usual clothes',
  night: 'nights, from 10 pm until she wakes (she sleeps in it)' };
// A new picture for a look she has, when it's the colour that's wrong (pictures.TRUE_COLOR_PROMPT).
const TRUE_COLOR = 'Make this picture look natural and true to life: clean neutral white light with accurate, realistic skin tones and colours and no colour cast. '
  + 'Keep everything else exactly the same: her face, expression, hair, clothes and pose, the framing, and the pure black background.';
const waistUp = (l) => ['main', 'relaxed'].includes(l.split('@')[0]);
let promptEdited = false;
const outfitKind = () => $('#outfitKind').value;
// The same instructions as studio/pictures.py, shown so they can be edited before Klein runs.
function kleinPrompt() {
  const base = state.choom.looks[$('#outfitBase').value] || {};
  const wearing = $('#outfitWearing').value.trim().replace(/\.$/, '');
  const keep = (base.kleinKeep || 'her face, expression, hair and pose').replace(/[,. ]+$/, '');
  // A full body or asleep picture keeps her clothes too: they are the point of an outfit's full body
  // (pictures.with_clothes). A full body stands relaxed, so it keeps no arms, hands or pose (Eve's crossed
  // arms), and what she holds without how (pictures.full_keep).
  const withClothes = (k) => (!k ? 'her face, hair and clothes' : /clothes/.test(k) ? k : `${k.replace(/,\s+and\s+(?=[^,]*$)/, ', ')}, and her clothes`);
  const kept = withClothes(base.kleinKeep ? keep : '');
  if (outfitKind() === 'full') {
    return 'Show her from head to toe, standing relaxed and facing the viewer, her whole figure in frame with a little black space above her head and below her feet. '
      + `Keep ${withClothes(base.kleinKeep ? fullKeep(keep) : '')} exactly as in the picture, with the same light on the same pure black background.${wearing ? ` She wears ${wearing}.` : ''}`;
  }
  if (outfitKind() === 'redo') return TRUE_COLOR;
  if (outfitKind() === 'place') {  // pictures.place_prompt: from her full body, keeping what her main look keeps
    const own = (base.kleinKeep || state.choom.looks.main?.kleinKeep || '').replace(/[,. ]+$/, '');
    return `Show her ${wearing || '…'}, her whole figure in frame with a little black space around her. `
      + `Keep ${withClothes(own ? fullKeep(own) : '')} exactly as in the picture, with the same light on the same pure black background.`;
  }
  if (outfitKind() === 'asleep') {
    return 'She has dozed off peacefully: her eyes are gently closed, her face is soft and relaxed, and her head tips slightly down and to one side. '
      + `Keep everything else exactly the same: ${kept}, the lighting, the framing, and the pure black background.`;
  }
  return `Change her clothes: she now wears ${wearing || '…'}. Keep everything else exactly the same: ${keep}, the lighting, the framing, and the pure black background.`;
}
// pictures.full_keep: her keep line without her pose, for a full body.
const POSE_WORDS = /\b(arms?|hands?|fingers?|pose|posture|crossed|clasped|raised|at her sides?)\b/i;
function fullKeep(keep) {
  return keep.replace(/[,. ]+$/, '').split(/,\s*(?:and\s+)?/).map((p) => p.trim()).filter(Boolean)
    .map((p) => { const held = p.match(/^(.+?)\s+(?:that\s+)?she\s+(?:holds|is holding|carries)\b/i); return held ? held[1] : POSE_WORDS.test(p) ? null : p; })
    .filter(Boolean).join(', ');
}
function outfitLookId() {
  const kind = outfitKind(), b = $('#outfitBase').value, o = b.split('@')[1];
  if (kind === 'redo') return $('#outfitTarget').value;
  // A full body or asleep look started from an outfit is that outfit's own (full@dayspandex, asleep@night).
  if (kind === 'full' || kind === 'asleep') return o ? `${kind}@${o}` : kind;
  const name = $('#outfitName').value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (kind === 'gone') return 'gone';
  if (kind === 'place') return name || '…';
  return `${b.split('@')[0]}@${$('#outfitWhen').value}${name}`;  // from another outfit too, in its pose
}
function updateOutfitForm() {
  const kind = outfitKind();
  $$('#newOutfit .when').forEach((e) => { e.hidden = kind !== 'outfit'; });
  $$('#newOutfit .named').forEach((e) => { e.hidden = kind !== 'outfit' && kind !== 'place'; });
  $$('#newOutfit .redo').forEach((e) => { e.hidden = kind !== 'redo'; });
  $$('#newOutfit .klein').forEach((e) => { e.hidden = kind === 'gone'; });
  $('#newOutfit .wearing').hidden = kind === 'asleep' || kind === 'redo' || kind === 'gone';
  $('#outfitNameLabel').textContent = kind === 'place' ? 'Name of the place' : 'Name (optional)';
  $('#outfitName').placeholder = kind === 'place' ? 'campfire' : 'dress';
  $('#outfitWearingLabel').textContent = kind === 'full' ? 'What she wears below the waist (optional; her top is kept)'
    : kind === 'place' ? 'Where she is and how' : 'She now wears';
  $('#outfitWearing').placeholder = kind === 'place' ? 'sitting on the ground beside a small campfire, her knees drawn up and her hands held toward the flames, looking up at the viewer'
    : 'a long burgundy dress with thin straps';
  $('#outfitMake').textContent = kind === 'gone' ? 'Make it' : 'Make pictures';
  if (!promptEdited) $('#outfitPrompt').value = kleinPrompt();
  const id = outfitLookId();
  if (kind === 'redo') {
    const n = Object.values(state.choom.clips).filter((c) => (c.from === id || c.to === id) && c.status !== 'dropped').length;
    $('#outfitLook').textContent = `${id} gets the new picture; its ${n} clip${n === 1 ? '' : 's'} will be planned again from it (old takes kept)`;
  } else {
    $('#outfitLook').textContent = state.choom.looks[id]?.picture ? `she already has ${id}${kind === 'outfit' ? ': give it a name' : ''}` : `becomes the look ${id}`;
  }
}
function renderOutfitForm() {
  // Klein can start from any of her waist-up looks (an outfit too; asleep only from her usual clothes
  // or a night outfit), and a new picture for a look from any look at all.
  const kind = outfitKind(), looks = state.choom.looks;
  const withPicture = lookOrder(looks).filter((l) => looks[l].picture);
  // A place starts from her full body (or a waist-up look): it's framed wide like the full body.
  const bases = withPicture.filter((l) => kind === 'redo' || (kind === 'place' && l === 'full') ||
                                          (waistUp(l) && (kind !== 'asleep' || !l.includes('@') || /^night/.test(l.split('@')[1]))));
  const wasTarget = $('#outfitTarget').value;
  $('#outfitTarget').replaceChildren(...withPicture.map((l) => el('option', { value: l, selected: l === (wasTarget || state.planLook) }, l)));
  const home = state.choom.sequence.length ? state.choom.clips[state.choom.sequence[0]].from : bases[0];
  const wardrobeBase = bases.find((l) => state.choom.looks[l].wardrobe) || home;
  const was = kind === 'place' && bases.includes('full') ? 'full' : $('#outfitBase').value;
  $('#outfitBase').replaceChildren(...bases.map((l) => el('option', { value: l, selected: l === (was || wardrobeBase) }, l)));
  if (!$('#outfitWhen').options.length) $('#outfitWhen').replaceChildren(...Object.entries(WHEN).map(([k, v]) => el('option', { value: k }, v)));
  updateOutfitForm();
}
['outfitBase', 'outfitWhen', 'outfitName', 'outfitWearing'].forEach((id) => $(`#${id}`).addEventListener('input', updateOutfitForm));
// A prompt changed by hand still takes what she wears: typing in "She now wears" puts it in place of the
// clothes the prompt names (after "wears", to the end of that sentence). It used to stop following once
// the prompt was touched anywhere ("Change her clothes and hair"), and Discard brings such a prompt back:
// four tries at Genesis's worn shop shirt sent Klein the same new button-down (2026-10-16).
const WEARS = /(\bwears )([\s\S]*?)(\.(?=\s|$))/;
function followWearing() {
  if (!promptEdited) return;
  const p = $('#outfitPrompt'), wearing = $('#outfitWearing').value.trim().replace(/\.$/, '');
  if (outfitKind() === 'full') {  // optional there: its own sentence at the end
    const without = p.value.replace(/\s*She wears [\s\S]*?\.(?=\s|$)/, '');
    p.value = wearing ? `${without} She wears ${wearing}.` : without;
  } else if (WEARS.test(p.value)) {
    p.value = p.value.replace(WEARS, (all, before, clothes, after) => `${before}${wearing || '…'}${after}`);
  }
}
$('#outfitWearing').addEventListener('input', followWearing);
$('#outfitRefs').addEventListener('change', () => { $('#outfitRefsHint').hidden = !$('#outfitRefs').files.length; });
// A new picture for a look starts from that look's own picture unless you choose another.
$('#outfitTarget').addEventListener('input', () => { $('#outfitBase').value = $('#outfitTarget').value; updateOutfitForm(); });
const readFile = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => fail(r.error); r.readAsDataURL(file); });
$('#outfitKind').addEventListener('input', () => {
  promptEdited = false;
  renderOutfitForm();
  if (outfitKind() === 'redo') { $('#outfitBase').value = $('#outfitTarget').value; updateOutfitForm(); }
});
$('#outfitPrompt').addEventListener('input', () => { promptEdited = true; });
$('#outfitMake').addEventListener('click', attempt(async () => {
  if (outfitKind() === 'gone') {
    state.choom = (await api(`/api/choom/${state.cid}/outfit`, { kind: 'gone', base: 'main' })).choom;
    toast('The empty glass is ready: plan “Walking on and off” in her full body (and main, to vanish and appear)');
    renderLooks();
    return;
  }
  if (outfitKind() === 'place' && !/^[a-z][a-z0-9]*$/.test($('#outfitName').value.trim().toLowerCase())) return toast('Name the place (letters and digits: campfire)', true);
  if (outfitKind() === 'place' && !$('#outfitWearing').value.trim() && !promptEdited) return toast('Say where she is and how', true);
  if (outfitKind() === 'outfit' && !$('#outfitWearing').value.trim() && !promptEdited) return toast('Say what she wears', true);
  // A prompt changed before "She now wears" was filled in stops following it and keeps the "…" where her
  // clothes go: Genesis's shop shirt and ponytail never reached Klein that way (2026-10-16).
  if ($('#outfitPrompt').value.includes('wears …')) {
    const wearing = $('#outfitWearing').value.trim().replace(/\.$/, '');
    if (!wearing) return toast('The prompt still says “…” where her clothes go: say what she wears', true);
    $('#outfitPrompt').value = $('#outfitPrompt').value.replace('wears …', `wears ${wearing}`);
  }
  // Klein reads only the prompt, and the look's Subject line is written from "She now wears": they have
  // to name the same clothes, or the picture and its clips go two ways (a new shirt said to be worn).
  const wears = $('#outfitWearing').value.trim().replace(/\.$/, '');
  if (wears && ['outfit', 'full'].includes(outfitKind()) && !$('#outfitPrompt').value.includes(wears)) {
    return toast('The prompt names different clothes from “She now wears”, and Klein only reads the prompt: make them the same', true);
  }
  const file = $('#outfitUpload').files[0], refs = [...$('#outfitRefs').files];
  state.choom = (await api(`/api/choom/${state.cid}/outfit`, {
    kind: outfitKind(), base: $('#outfitBase').value, when: $('#outfitWhen').value, name: $('#outfitName').value,
    wearing: $('#outfitWearing').value, prompt: $('#outfitPrompt').value, count: Number($('#outfitCount').value),
    look: $('#outfitTarget').value, upload: file ? await readFile(file) : undefined,
    refs: refs.length ? await Promise.all(refs.map(readFile)) : undefined,
  })).choom;
  $('#outfitUpload').value = ''; $('#outfitRefs').value = ''; $('#outfitRefsHint').hidden = true;
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
          const res = await api(`/api/choom/${state.cid}/adopt`, { look, picture: f });
          state.choom = res.choom;
          toast(res.replanned ? `${look} has its new picture: ${res.replanned.length} clips planned again; render them from Plan & render`
            : `${look} is a look now: plan its clips in Plan & render`);
          renderLooks();
        }),
        tip: 'Make this version the look',
      }, 'Use this one')))),
    el('div', { className: 'row' }, el('button', {
      className: 'ghost', type: 'button', onclick: attempt(async () => {
        state.choom = (await api(`/api/choom/${state.cid}/discard`, { look })).choom;
        renderLooks();
        refillOutfitForm(look, d);
      }),
      tip: 'Throw these versions away and put their settings back in the form, to change the prompt and try again (the files stay in clean/drafts)',
    }, 'Discard')))));
}
// Discarded versions: the form comes back as it was for them (kind, start look, when and name, what
// she wears, the prompt, how many), so a new try is one changed line away instead of starting over.
function refillOutfitForm(look, d) {
  if (!d.kind) return;  // a new Choom's first picture: not from this form
  promptEdited = false;
  $('#outfitKind').value = d.kind;
  renderOutfitForm();
  if (d.base) $('#outfitBase').value = d.base;
  if (d.kind === 'redo') $('#outfitTarget').value = look;
  if (d.kind === 'outfit') {
    const part = look.split('@')[1] || '';  // versions made before the form was kept: from the look's name
    const when = d.when || Object.keys(WHEN).find((w) => part.startsWith(w)) || $('#outfitWhen').value;
    $('#outfitWhen').value = when;
    $('#outfitName').value = d.name ?? part.slice(when.length);
  }
  $('#outfitWearing').value = d.wearing || '';
  if (d.count) $('#outfitCount').value = String(d.count);
  updateOutfitForm();
  if (d.prompt && d.prompt !== $('#outfitPrompt').value) { $('#outfitPrompt').value = d.prompt; promptEdited = true; }
  $('#newOutfit').open = true;
  $('#newOutfit').scrollIntoView({ block: 'start' });
  toast(d.upload || d.refs?.length ? 'Its settings are back in the form; choose the pictures from your computer again'
    : 'Its settings are back in the form: change what you like and make pictures again');
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
const STATE_WORDS = { waiting: 'waiting', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled',
  paused: 'paused', cancelling: 'stopping…' };
const LIVE = ['waiting', 'running', 'paused', 'cancelling'];
const GPU = ['render', 'build', 'picture', 'still'];
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// Where a queue's render stands, for the clips queued in it.
function queueWords(queue) {
  const job = state.jobs.find((j) => j.kind === 'render' && LIVE.includes(j.status) && [j.args.queue, ...(j.args.earlier || [])].includes(queue));
  if (!job) return 'queued';
  if (job.status === 'running') return 'rendering now';
  if (job.status === 'paused' || state.worklist?.paused) return 'queued, the work list is paused';
  if (job.not_before > Date.now() / 1000) return `queued, render at ${clock(job.not_before)}`;
  return 'queued, waiting for the GPU';
}
function queuedSummary(c) {
  const groups = {};
  for (const k of Object.values(c.clips)) if (k.status === 'queued') { const w = queueWords(k.queue); groups[w] = (groups[w] || 0) + 1; }
  return Object.entries(groups).map(([w, n]) => `${n} ${w}`).join(' · ');
}
// What a job just started waits behind, in words (the server says what's ahead of it).
function startWords(r, now) {
  if (r.ahead?.paused) return 'Queued; the work list is paused, so it starts when you resume';
  if (r.ahead?.jobs?.length) return `Queued; it starts after the ${r.ahead.jobs[0]}${r.ahead.jobs.length > 1 ? ` and ${r.ahead.jobs.length - 1} more` : ''} ahead of it on the GPU`;
  return now;
}
async function pollJobs() {
  try {
    const was = state.jobs.filter((j) => j.status === 'running');
    const before = was.map((j) => j.id).join() + `:${was.find((j) => j.kind === 'render')?.progress?.done ?? ''}`;
    const res = await api('/api/jobs');
    state.jobs = res.jobs;
    state.worklist = res.worklist || {};
    const running = state.jobs.filter((j) => j.status === 'running');
    const waiting = state.jobs.filter((j) => j.status === 'waiting');
    const pill = $('#jobsButton');
    const r = running.find((j) => j.kind === 'render');
    const lastFailed = state.jobs.length && state.jobs[state.jobs.length - 1].status === 'failed';
    const wl = state.worklist;
    pill.className = `jobs-pill${wl.paused ? ' paused' : running.length ? ' busy' : lastFailed ? ' failed' : ''}`;
    $('#jobsText').textContent = wl.paused ? `Paused${waiting.length ? ` · ${waiting.length} waiting` : ''}`
      : r ? `${wl.pausing ? 'Pausing · ' : 'Rendering '}${r.progress?.done ?? 0}/${r.progress?.total || r.args.clips}`
        : running.length ? `${wl.pausing ? 'Pausing · ' : ''}${{ build: 'Building', picture: 'Klein', still: 'Still relief', relaunch: 'Reloading the glass', review: 'Checking' }[running[0].kind] || 'Working'}…`
          : waiting.length ? `${waiting.length} waiting` : lastFailed ? 'Last job failed' : 'Idle';
    renderPaused();
    renderJobs();
    // Refresh her clips when work starts or ends, or when a render lands another clip.
    const after = running.map((j) => j.id).join() + `:${r?.progress?.done ?? ''}`;
    if (before !== after && state.cid) await refresh();
  } catch { /* the server may be restarting */ }
}
setInterval(pollJobs, 8000);

function renderJobs() {
  $('#pauseButton').textContent = state.worklist?.paused || state.worklist?.pausing ? 'Resume' : 'Pause';
  const newest = [...state.jobs].reverse();
  const live = newest.filter((j) => LIVE.includes(j.status));  // a long render stays on top of its reviews
  $('#jobsList').replaceChildren(...[...live, ...newest.filter((j) => !live.includes(j))].slice(0, 15).map((j) => {
    const p = j.progress || {};
    const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
    const what = j.kind === 'render' ? `${j.args.clips} clips (${j.args.queue})` : j.args.choom || '';
    const when = j.status !== 'waiting' ? '' : j.after ? ' until the render has finished'
      : j.not_before > Date.now() / 1000 ? ` until ${clock(j.not_before)}` : '';
    return el('div', { className: `job ${j.status}` },
      el('div', { className: 'row' }, el('span', {}, el('span', { className: 'kind' }, j.kind), ` ${what}`),
        el('span', { className: 'state' }, `${STATE_WORDS[j.status]}${when}${j.status === 'running' && p.total ? ` · ${p.done}/${p.total} ${p.step || ''}` : ''}`)),
      j.kind === 'render' && j.status === 'running' ? el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })) : null,
      j.error ? el('div', { className: 'state' }, j.error) : null,
      j.log?.length && j.status !== 'done' ? el('pre', {}, j.log.slice(-8).join('\n')) : null,
      ['waiting', 'running', 'paused'].includes(j.status) ? el('div', {}, el('button', {
        className: 'ghost', type: 'button', onclick: attempt(async () => { await api(`/api/jobs/${j.id}/cancel`, {}); pollJobs(); }),
        tip: j.kind === 'render' ? 'Stop Wan2GP; clips not rendered yet go back to planned' : 'Cancel this job',
      }, 'Cancel')) : null);
  }));
  if (!state.jobs.length) $('#jobsList').replaceChildren(el('p', { className: 'muted' }, 'No work yet.'));
}
$('#jobsButton').addEventListener('click', () => { $('#jobsPanel').hidden = !$('#jobsPanel').hidden; renderJobs(); });
$('#jobsClose').addEventListener('click', () => { $('#jobsPanel').hidden = true; });

// The work list's pause: what's on the GPU finishes its item (a render, the clip it's on), then
// nothing more starts there until it's resumed.
function renderPaused() {
  const wl = state.worklist || {};
  $('#pausedBanner').hidden = !(wl.paused || wl.pausing);
  if (!(wl.paused || wl.pausing)) return;
  const r = state.jobs.find((j) => j.kind === 'render' && j.status === 'running');
  const other = state.jobs.find((j) => GPU.includes(j.kind) && j.status === 'running');
  const held = state.jobs.filter((j) => GPU.includes(j.kind) && ['waiting', 'paused'].includes(j.status)).length;
  $('#pausedText').textContent = wl.pausing
    ? (r ? `Pausing: the render stops once the clip it's on has landed (clip ${(r.progress?.done ?? 0) + 1} of ${r.progress?.total || r.args.clips}).`
      : `Pausing: the ${other?.kind || 'job'} running now finishes first.`)
    : `The work list is paused${held ? `: ${held} job${held === 1 ? '' : 's'} waiting` : ''}. Nothing starts on the GPU until you resume.`;
}
async function resumeWork() {
  state.worklist = (await api('/api/jobs/resume', {})).worklist;
  toast('Resumed: the work list carries on');
  pollJobs();
}
$('#resumeButton').addEventListener('click', attempt(resumeWork));
$('#pauseButton').addEventListener('click', attempt(async () => {
  if (state.worklist?.paused || state.worklist?.pausing) return resumeWork();
  await pollJobs();  // what's running right now, not as of the last poll
  const r = state.jobs.find((j) => j.kind === 'render' && j.status === 'running');
  const other = state.jobs.find((j) => GPU.includes(j.kind) && j.status === 'running');
  const mins = Math.round(state.minutesPerClip || 6);
  $('#pauseWhat').textContent = r
    ? `The render finishes the clip it's on (clip ${(r.progress?.done ?? 0) + 1} of ${r.progress?.total || r.args.clips}, up to about ${mins} minutes), then stops. Its other clips stay queued and render when you resume.`
    : other ? `The ${{ build: 'build', picture: 'Klein pictures', still: 'still relief' }[other.kind] || other.kind} running now finishes first (it can't stop halfway without starting over), then the work list holds.`
      : 'Nothing is running on the GPU now, so it pauses straight away.';
  $('#pauseDialog').showModal();
}));
$('#pauseCancel').addEventListener('click', () => $('#pauseDialog').close());
$('#pauseConfirm').addEventListener('click', attempt(async () => {
  $('#pauseDialog').close();
  state.worklist = (await api('/api/jobs/pause', {})).worklist;
  toast(state.worklist.paused ? 'Paused: nothing starts on the GPU until you resume' : 'Pausing: it stops when the item it is on is finished');
  pollJobs();
}));

// Clean-up: what nothing uses any more, and disk use.
const CLEAN_WORDS = { dropped: 'Videos of dropped clips', takes: 'Old takes (re-rolls replaced them)', drafts: 'Klein versions no look is waiting on',
  queues: 'Finished render queues', caches: 'Cut-out and depth caches of clips she no longer has' };
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`);
async function surveyCleanup() {
  $('#cleanupGo').disabled = true;
  $('#cleanupGo').textContent = 'Delete the ticked';
  delete $('#cleanupGo').dataset.armed;
  const r = await api(`/api/housekeeping?takes_days=${Number($('#cleanupDays').value) || 30}`);
  $('#cleanupDisk').textContent = `Workspace ${gb(r.disk.workspace)} · portraits ${gb(r.disk.portraits)} · ${gb(r.disk.free)} free of ${gb(r.disk.total)}`;
  $('#cleanupList').replaceChildren(...Object.keys(CLEAN_WORDS).map((k) => el('label', { className: 'check' },
    el('input', { type: 'checkbox', value: k, disabled: !r[k].count, onchange: () => {
      const ticked = $$('#cleanupList input:checked');
      $('#cleanupGo').disabled = !ticked.length;
    } }),
    ` ${CLEAN_WORDS[k]}: ${r[k].count ? `${r[k].count} · ${gb(r[k].bytes)}` : 'nothing'}`)));
  state.cleanup = r;
}
$('#cleanupButton').addEventListener('click', attempt(async () => { $('#cleanupDialog').showModal(); await surveyCleanup(); }));
$('#cleanupDays').addEventListener('change', attempt(surveyCleanup));
$('#cleanupClose').addEventListener('click', () => $('#cleanupDialog').close());
$('#cleanupGo').addEventListener('click', attempt(async () => {
  const cats = $$('#cleanupList input:checked').map((i) => i.value);
  const go = $('#cleanupGo');
  if (!go.dataset.armed) {  // a second click deletes: the dialog itself is the confirmation
    const n = cats.reduce((a, k) => a + state.cleanup[k].count, 0), b = cats.reduce((a, k) => a + state.cleanup[k].bytes, 0);
    go.dataset.armed = '1';
    go.textContent = `Really delete ${n} files (${gb(b)})?`;
    return;
  }
  const r = await api('/api/housekeeping', { categories: cats, takesDays: Number($('#cleanupDays').value) || 30 });
  toast(`Freed ${gb(Object.values(r.freed).reduce((a, b) => a + b, 0))}`);
  await surveyCleanup();
}));

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
