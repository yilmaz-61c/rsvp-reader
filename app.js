'use strict';
// RSVP speed reader. Words are flashed one at a time with the Optimal
// Recognition Point (ORP) letter pinned to the screen center, so the eye
// never has to move across the word.

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- settings ----------
const defaults = { wpm: 300, smart: true, ramp: true, chunk: 1, theme: 'dark', font: 'mono', size: 64, accent: '#ff6a00', quiz: 'end', ghost: false, context: true, focus: false, click: false, noise: false, eye: true, goal: 1000 };
const S = Object.assign({}, defaults, store.get('rsvp.settings', {}));
const saveSettings = () => store.set('rsvp.settings', S);

function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = S.theme;
  r.dataset.font = S.font;
  document.body.classList.toggle('focus', S.focus);
  if (typeof refreshView === 'function') refreshView();
  r.style.setProperty('--size', S.size + 'px');
  r.style.setProperty('--accent', S.accent);
  document.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c === S.accent));
  $('sAccent').value = S.accent;
  $('wpm').value = S.wpm;
  $('wpmVal').textContent = S.wpm;
  updateEta();
}

// ---------- ORP ----------
function orpIndex(len) {
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}

function splitWord(str) {
  const chars = Array.from(str);
  const isCore = (c) => /[\p{L}\p{N}]/u.test(c);
  let lead = 0;
  while (lead < chars.length && !isCore(chars[lead])) lead++;
  let end = chars.length;
  while (end > lead && !isCore(chars[end - 1])) end--;
  const idx = Math.min(chars.length - 1, lead + orpIndex(end - lead));
  return [chars.slice(0, idx).join(''), chars[idx] || '', chars.slice(idx + 1).join('')];
}

function render(str) {
  const [l, p, r] = splitWord(str);
  $('wl').textContent = l;
  $('wp').textContent = p;
  $('wr').textContent = r;
}

// ---------- tokenizer ----------
const doc = { id: null, title: '', words: [], paraEnd: null, text: '' };
let pos = 0;

function tokenize(text) {
  const words = [];
  const ends = [];
  for (const para of text.split(/\n\s*\n/)) {
    const toks = para.split(/\s+/).filter(Boolean);
    for (let t of toks) {
      // break very long tokens (urls, glued words) into readable pieces
      while (Array.from(t).length > 18) {
        const a = Array.from(t);
        words.push(a.slice(0, 13).join('') + '-');
        ends.push(0);
        t = a.slice(13).join('');
      }
      words.push(t);
      ends.push(0);
    }
    if (toks.length) ends[ends.length - 1] = 1;
  }
  return { words, ends: Uint8Array.from(ends) };
}

const isSentenceEnd = (w) => /[.!?…]["'”’)\]]*$/.test(w);
function sentenceStart(i) {
  while (i > 0 && !isSentenceEnd(doc.words[i - 1])) i--;
  return i;
}
function nextSentence(i) {
  const n = doc.words.length;
  while (i < n - 1 && !isSentenceEnd(doc.words[i])) i++;
  return Math.min(i + 1, n - 1);
}

// ---------- engine ----------
let playing = false, timer = 0, pressAt = 0, sessionStart = 0, sessionWords = 0;
let shown = 0, eyeMs = 0, quizFrom = 0, nextQuizAt = Infinity, wakeLock = null;

function delayFor(unit, elapsed) {
  let d = 60000 / S.wpm * unit.length;
  if (S.smart) {
    const last = unit[unit.length - 1];
    const end = pos + unit.length - 1;
    const alpha = Math.max(...unit.map((w) => (w.match(/[\p{L}\p{N}]/gu) || []).length));
    let m = alpha > 13 ? 1.6 : alpha >= 8 ? 1.3 : 1;
    if (isSentenceEnd(last)) {
      const len = end - sentenceStart(end) + 1;
      m += len <= 7 ? 0.5 : len <= 22 ? 1.2 : 2.3;
    } else if (/[,;:–—]["'”’)\]]*$/.test(last)) m += 0.5;
    if (doc.paraEnd[end]) m = Math.max(m, 2.5);
    d *= m;
  }
  if (S.ramp) d /= 0.6 + 0.4 * Math.min(1, elapsed / 1500);
  return d;
}

function step() {
  if (!playing) return;
  if (pos >= doc.words.length) return finish();
  if (pos >= nextQuizAt) return quizBreak();
  const unit = doc.words.slice(pos, pos + S.chunk);
  shown = pos;
  render(unit.join(' '));
  renderGhost();
  if (S.click) tick();
  const d = delayFor(unit, performance.now() - pressAt);
  pos += unit.length;
  sessionWords += unit.length;
  updateProgress();
  if ((pos & 31) < S.chunk) persistPos();
  timer = setTimeout(step, d);
}

async function lockScreen() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function play() {
  if (playing || !doc.words.length || panelOpen()) return;
  if (pos >= doc.words.length) { pos = 0; quizFrom = 0; setQuizTrigger(); }
  playing = true;
  pressAt = sessionStart = performance.now();
  sessionWords = 0;
  document.body.classList.add('playing');
  lockScreen();
  startNoise();
  step();
}

function pause() {
  if (!playing) return;
  playing = false;
  clearTimeout(timer);
  document.body.classList.remove('playing');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  const dur = performance.now() - sessionStart;
  stopNoise();
  addStats(sessionWords, dur, 0, 0);
  logSession(sessionWords, dur);
  persistPos();
  renderContext();
  eyeMs += dur;
  if (S.eye && eyeMs >= 20 * 60000) { eyeMs = 0; showHint('Eye break: look at something 20 feet (6 m) away for 20 seconds.'); }
}

function finish() {
  pause();
  pos = doc.words.length;
  updateProgress();
  if (S.quiz !== '0') openQuiz(); else showHint('Finished. Press to read again.');
}

function seek(i) {
  pos = Math.max(0, Math.min(doc.words.length - 1, i));
  shown = pos;
  if (!playing) { render(doc.words.slice(pos, pos + S.chunk).join(' ')); renderGhost(); renderContext(); }
  updateProgress();
  persistPos();
}

function setWpm(v) {
  S.wpm = Math.max(100, Math.min(1000, v));
  saveSettings();
  $('wpm').value = S.wpm;
  $('wpmVal').textContent = S.wpm;
  updateEta();
}

function showHint(t) { $('hint').textContent = t; }

function updateProgress() {
  const n = doc.words.length;
  $('progress').value = n ? Math.round((pos / n) * 1000) : 0;
  $('progText').textContent = `${pos} / ${n}`;
  updateEta();
}
function updateEta() {
  const left = Math.max(0, doc.words.length - pos);
  const min = left / S.wpm;
  $('eta').textContent = left ? (min < 1 ? '<1 min' : `${Math.round(min)} min`) : '';
}

// ---------- input ----------
const stage = $('stage');
let pressed = false, downX = 0, downY = 0, swiped = false;

stage.addEventListener('pointerdown', (e) => {
  if (panelOpen()) return;
  pressed = true; swiped = false; downX = e.clientX; downY = e.clientY;
  try { stage.setPointerCapture(e.pointerId); } catch {}
  play();
});
stage.addEventListener('pointermove', (e) => {
  if (!pressed || swiped) return;
  const dx = e.clientX - downX, dy = e.clientY - downY;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
    swiped = true;
    pause();
    seek(dx < 0 ? nextSentence(pos) : prevSentence());
  }
});
const release = () => { pressed = false; pause(); };
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
stage.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

function prevSentence() {
  const s = sentenceStart(pos);
  return pos - s > 3 ? s : sentenceStart(Math.max(0, s - 1));
}

window.addEventListener('keydown', (e) => {
  if (panelOpen() || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) play(); }
  else if (e.key === 'ArrowLeft') { pause(); seek(e.shiftKey ? pos - 5 : prevSentence()); }
  else if (e.key === 'ArrowRight') { pause(); seek(e.shiftKey ? pos + 5 : nextSentence(pos)); }
  else if (e.key === 'PageUp') { pause(); seek(pos - 100); }
  else if (e.key === 'PageDown') { pause(); seek(pos + 100); }
  else if (e.key === '+' || e.key === '=') setSize(S.size + 4);
  else if (e.key === '-') setSize(S.size - 4);
  else if (e.key === '0') setSize(64);
  else if (e.key.toLowerCase() === 'f') { S.focus = !S.focus; $('sFocus').checked = S.focus; saveSettings(); applySettings(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setWpm(S.wpm + 25); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setWpm(S.wpm - 25); }
  else if (e.key.toLowerCase() === 'r') { pause(); seek(0); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') pause(); });

function setSize(v) {
  S.size = Math.max(28, Math.min(120, v));
  $('sSize').value = S.size;
  saveSettings();
  applySettings();
}
$('wpmVal').addEventListener('pointerdown', (e) => e.stopPropagation());
$('wpmVal').addEventListener('click', () => {
  pause();
  const v = parseInt(prompt('Words per minute (100–1000):', S.wpm), 10);
  if (v) setWpm(v);
});
$('wpm').addEventListener('input', (e) => setWpm(+e.target.value));
$('progress').addEventListener('input', (e) => {
  pause();
  seek(Math.round((+e.target.value / 1000) * doc.words.length));
});

// ---------- panels ----------
const panels = ['pLibrary', 'pSettings', 'pStats', 'pQuiz'];
const panelOpen = () => panels.some((id) => !$(id).hidden);
function openPanel(id) { pause(); $(id).hidden = false; }
function closePanels() { panels.forEach((id) => ($(id).hidden = true)); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
panels.forEach((id) => $(id).addEventListener('pointerdown', (e) => { if (e.target === $(id) && id !== 'pQuiz') closePanels(); }));
$('btnLibrary').onclick = () => { renderLibrary(); openPanel('pLibrary'); };
$('btnSettings').onclick = () => openPanel('pSettings');
$('btnStats').onclick = () => { renderStats(); openPanel('pStats'); };

// settings bindings
const bind = (id, key, conv = (v) => v, prop = 'value') => {
  const el = $(id);
  el[prop] = S[key];
  el.addEventListener('change', () => { S[key] = conv(el[prop]); saveSettings(); applySettings(); });
};
bind('sSmart', 'smart', Boolean, 'checked');
bind('sRamp', 'ramp', Boolean, 'checked');
bind('sChunk', 'chunk', Number);
bind('sTheme', 'theme');
bind('sFont', 'font');
bind('sSize', 'size', Number);
bind('sAccent', 'accent');
bind('sQuiz', 'quiz');
document.querySelectorAll('.sw').forEach((b) => b.addEventListener('click', () => { S.accent = b.dataset.c; saveSettings(); applySettings(); }));
bind('sGhost', 'ghost', Boolean, 'checked');
bind('sContext', 'context', Boolean, 'checked');
bind('sFocus', 'focus', Boolean, 'checked');
bind('sClick', 'click', Boolean, 'checked');
bind('sNoise', 'noise', Boolean, 'checked');
bind('sEye', 'eye', Boolean, 'checked');
bind('sGoal', 'goal', (v) => Math.max(0, parseInt(v, 10) || 0), 'value');
$('sSize').addEventListener('input', (e) => document.documentElement.style.setProperty('--size', e.target.value + 'px'));

// ---------- storage: texts in IndexedDB, metadata in localStorage ----------
const mem = new Map();
const idb = new Promise((res) => {
  // fall back to memory if IndexedDB is unavailable or hangs (e.g. private mode)
  const t = setTimeout(() => res(null), 2000);
  try {
    const rq = indexedDB.open('rsvp', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('texts');
    rq.onsuccess = () => { clearTimeout(t); res(rq.result); };
    rq.onerror = () => { clearTimeout(t); res(null); };
  } catch { clearTimeout(t); res(null); }
});
async function idbOp(mode, fn) {
  const db = await idb;
  if (!db) {
    const fake = {
      put: (v, k) => mem.set(k, v), delete: (k) => mem.delete(k),
      get: (k) => mem.get(k), getAllKeys: () => [...mem.keys()],
    };
    const r = fn(fake);
    return r;
  }
  return new Promise((res, rej) => {
    const rq = fn(db.transaction('texts', mode).objectStore('texts'));
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

let lib = store.get('rsvp.lib', []);
const saveLib = () => store.set('rsvp.lib', lib);

function persistPos() {
  const m = lib.find((x) => x.id === doc.id);
  if (m) { m.pos = pos; m.at = Date.now(); saveLib(); }
}

async function addText(title, text, chapters) {
  const id = 't' + Date.now().toString(36);
  const { words } = tokenize(text);
  lib.unshift({ id, title, count: words.length, pos: 0, at: Date.now(), chapters: chapters || [] });
  saveLib();
  await idbOp('readwrite', (s) => s.put(text, id));
  await openText(id);
}

async function openText(id) {
  const m = lib.find((x) => x.id === id);
  if (!m) return;
  const text = await idbOp('readonly', (s) => s.get(id));
  if (!text) return;
  pause();
  const t = tokenize(text);
  Object.assign(doc, { id, title: m.title, words: t.words, paraEnd: t.ends, text });
  pos = Math.max(0, Math.min((m.pos || 0) - (m.pos > 10 ? 10 : 0), Math.max(0, t.words.length - 1)));
  shown = pos;
  quizFrom = pos;
  doc.chapters = m.chapters || [];
  setQuizTrigger();
  store.set('rsvp.last', id);
  $('title').textContent = m.title;
  showHint('Press & hold anywhere (or hold Space) to read. Release to stop.');
  render(t.words.slice(pos, pos + S.chunk).join(' '));
  updateProgress();
  renderGhost();
  renderContext();
  closePanels();
}

function renderLibrary() {
  const ul = $('libList');
  ul.textContent = '';
  for (const m of lib) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = m.title;
    const small = document.createElement('small');
    small.textContent = Math.round((m.pos / Math.max(1, m.count)) * 100) + '%';
    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = async (e) => {
      e.stopPropagation();
      lib = lib.filter((x) => x.id !== m.id);
      saveLib();
      await idbOp('readwrite', (s) => s.delete(m.id));
      renderLibrary();
    };
    li.append(t, small, del);
    li.onclick = () => openText(m.id);
    ul.append(li);
  }
}

$('btnPaste').onclick = () => {
  const text = $('pasteBox').value.trim();
  if (!text) return;
  $('pasteBox').value = '';
  addText(text.split(/\s+/).slice(0, 6).join(' ') + '…', text);
};

$('fileIn').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    if (/\.epub$/i.test(f.name)) {
      const { title, text, chapters } = await parseEpub(await f.arrayBuffer());
      await addText(title || f.name.replace(/\.epub$/i, ''), text, chapters);
    } else {
      let txt = await f.text();
      if (/\.html?$/i.test(f.name)) txt = htmlToText(txt);
      await addText(f.name.replace(/\.\w+$/, ''), txt);
    }
  } catch (err) {
    alert('Could not read file: ' + err.message);
  }
});

// ---------- EPUB (minimal zip + OPF reader, no dependencies) ----------
async function parseEpub(buf) {
  const dv = new DataView(buf);
  let eocd = buf.byteLength - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nl));
    entries.set(name, { method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) });
    p += 46 + nl + el + cl;
  }
  async function file(name) {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const raw = buf.slice(start, start + e.csize);
    if (e.method === 0) return dec.decode(raw);
    const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return dec.decode(out);
  }
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await file('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const opf = xml(await file(opfPath));
  const base = 'http://x/' + opfPath;
  const items = {};
  opf.querySelectorAll('manifest > item').forEach((it) => (items[it.getAttribute('id')] = it.getAttribute('href')));
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent.trim();
  let text = '';
  const chapters = [];
  let words = 0;
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const href = items[ref.getAttribute('idref')];
    if (!href) continue;
    const path = decodeURIComponent(new URL(href, base).pathname.slice(1));
    const html = await file(path);
    if (!html) continue;
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('script,style').forEach((n) => n.remove());
    d.body.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,br,tr').forEach((n) => n.append('\n\n'));
    const chunk = d.body.textContent + '\n\n';
    const n = tokenize(chunk).words.length;
    const head = d.querySelector('h1,h2,h3')?.textContent.trim().replace(/\s+/g, ' ');
    if (n >= 30) chapters.push({ t: (head || 'Section ' + (chapters.length + 1)).slice(0, 80), w: words });
    words += n;
    text += chunk;
  }
  if (!text.trim()) throw new Error('no readable text found');
  return { title, text, chapters };
}

// ---------- stats ----------
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function addStats(words, ms, qc, qt) {
  if (!words && !qt) return;
  const all = store.get('rsvp.stats', {});
  const k = dayKey();
  const d = all[k] || { words: 0, ms: 0, qc: 0, qt: 0 };
  d.words += words; d.ms += ms; d.qc += qc; d.qt += qt;
  all[k] = d;
  store.set('rsvp.stats', all);
}

function renderStats() {
  const all = store.get('rsvp.stats', {});
  const days = Object.values(all);
  const words = days.reduce((a, d) => a + d.words, 0);
  const ms = days.reduce((a, d) => a + d.ms, 0);
  const qc = days.reduce((a, d) => a + d.qc, 0), qt = days.reduce((a, d) => a + d.qt, 0);
  let streak = 0;
  const c = new Date();
  if (!all[dayKey(c)]?.words) c.setDate(c.getDate() - 1);
  while (all[dayKey(c)]?.words) { streak++; c.setDate(c.getDate() - 1); }
  const keys = Object.keys(all).filter((k) => all[k].words).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    const cur = new Date(k + 'T00:00:00');
    run = prev && Math.round((cur - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = cur;
  }
  const cells = [
    [words.toLocaleString(), 'total words'],
    [ms > 3000 ? Math.round(words / (ms / 60000)) : '–', 'avg WPM'],
    [streak + ' d', `streak (best ${best} d)`],
    [qt ? Math.round((qc / qt) * 100) + '%' : '–', 'quiz accuracy'],
  ];
  $('statGrid').textContent = '';
  for (const [v, l] of cells) {
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = v;
    div.append(b, l);
    $('statGrid').append(div);
  }
  const today = all[dayKey()]?.words || 0;
  $('goalWrap').hidden = !S.goal;
  $('goalBar').firstElementChild.style.width = Math.min(100, (today / Math.max(1, S.goal)) * 100) + '%';
  $('goalText').textContent = `Today: ${today.toLocaleString()} / ${S.goal.toLocaleString()} words`;
  const sl = $('sessList');
  sl.textContent = '';
  for (const s of store.get('rsvp.sessions', []).slice(0, 8)) {
    const li = document.createElement('li');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = s.t;
    b.textContent = `${s.wpm} WPM · ${s.w}w · ${s.s}s`;
    li.append(a, b);
    sl.append(li);
  }
  const vals = [];
  const t = new Date();
  t.setDate(t.getDate() - 13);
  for (let i = 0; i < 14; i++) { vals.push(all[dayKey(t)]?.words || 0); t.setDate(t.getDate() + 1); }
  const max = Math.max(1, ...vals);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = $('chart');
  svg.textContent = '';
  vals.forEach((v, i) => {
    const r = document.createElementNS(ns, 'rect');
    const h = (v / max) * 90;
    r.setAttribute('x', i * 20 + 3); r.setAttribute('width', 14);
    r.setAttribute('y', 98 - h); r.setAttribute('height', Math.max(h, 1));
    r.setAttribute('rx', 2); r.setAttribute('fill', S.accent);
    svg.append(r);
  });
}

// ---------- comprehension quiz (cloze questions built locally) ----------
function setQuizTrigger() {
  const n = parseInt(S.quiz, 10);
  nextQuizAt = n ? quizFrom + n : Infinity;
}
// the "every N words" setting changes the trigger immediately
$('sQuiz').addEventListener('change', setQuizTrigger);

function quizBreak() {
  pause();
  openQuiz();
}

const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const strip = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

function buildQuestions() {
  const from = Math.max(0, Math.min(quizFrom, doc.words.length - 1));
  const seg = doc.words.slice(from, pos);
  const sents = [];
  let cur = [];
  for (const w of seg) {
    cur.push(w);
    if (isSentenceEnd(w)) { sents.push(cur); cur = []; }
  }
  const good = sents.filter((s) => s.length >= 8 && s.length <= 40);
  const pool = [...new Set(doc.words.map((w) => strip(w).toLowerCase()).filter((w) => w.length >= 5))];
  const qs = [];
  for (const s of shuffle(good)) {
    if (qs.length >= 3) break;
    const cand = s.map((w, i) => [i, strip(w)]).filter(([, w]) => w.length >= 6 && /^\p{L}+$/u.test(w));
    if (!cand.length) continue;
    const [idx, ans] = rnd(cand);
    const wrong = shuffle(pool.filter((w) => w !== ans.toLowerCase() && Math.abs(w.length - ans.length) <= 3)).slice(0, 3);
    if (wrong.length < 3) continue;
    const blanked = s.map((w, i) => (i === idx ? w.replace(ans, '_____') : w)).join(' ');
    const match = (w) => (ans[0] === ans[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w);
    qs.push({ q: blanked, ans, opts: shuffle([ans, ...wrong.map(match)]) });
  }
  return qs;
}

function openQuiz() {
  const qs = buildQuestions();
  quizFrom = pos;
  setQuizTrigger();
  if (!qs.length) { showHint(pos >= doc.words.length ? 'Finished. Press to read again.' : 'Press & hold to continue.'); return; }
  const body = $('quizBody');
  body.textContent = '';
  const intro = document.createElement('div');
  intro.className = 'muted';
  intro.textContent = 'Which word is missing?';
  body.append(intro);
  let done = 0, correct = 0;
  qs.forEach((q) => {
    const wrap = document.createElement('div');
    wrap.className = 'q';
    const p = document.createElement('p');
    p.textContent = q.q;
    wrap.append(p);
    q.opts.forEach((o) => {
      const b = document.createElement('button');
      b.className = 'chip opt';
      b.textContent = o;
      b.onclick = () => {
        wrap.querySelectorAll('button').forEach((x) => { x.disabled = true; if (x.textContent === q.ans) x.classList.add('ok'); });
        if (o === q.ans) correct++; else b.classList.add('bad');
        if (++done === qs.length) {
          addStats(0, 0, correct, qs.length);
          const btn = document.createElement('button');
          btn.className = 'primary';
          btn.textContent = `${correct}/${qs.length} correct — continue`;
          btn.onclick = closePanels;
          body.append(btn);
        }
      };
      wrap.append(b);
    });
    body.append(wrap);
  });
  $('pQuiz').hidden = false;
}

// ---------- html / url import ----------
function htmlToText(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,nav,footer,header,aside').forEach((n) => n.remove());
  d.body.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,br,tr').forEach((n) => n.append('\n\n'));
  return d.body.textContent;
}
$('btnUrl').onclick = async () => {
  const u = $('urlIn').value.trim();
  if (!u) return;
  try {
    const r = await fetch(u);
    const raw = await r.text();
    const d = new DOMParser().parseFromString(raw, 'text/html');
    const text = /<html|<body|<p[ >]/i.test(raw) ? htmlToText(raw) : raw;
    $('urlIn').value = '';
    await addText((d.title || u).slice(0, 80), text);
  } catch (err) {
    alert('Could not fetch (the site probably blocks cross-origin requests). Paste the text instead.');
  }
};

// ---------- ghost words, context view, chapters ----------
function renderGhost() {
  const on = S.ghost && doc.words.length;
  $('gl').textContent = on ? doc.words.slice(Math.max(0, shown - 3), shown).join(' ') : '';
  $('gr').textContent = on ? doc.words.slice(shown + S.chunk, shown + S.chunk + 3).join(' ') : '';
}

function renderContext() {
  const el = $('context');
  el.textContent = '';
  if (!S.context || playing || !doc.words.length) return;
  const from = Math.max(0, shown - 25), to = Math.min(doc.words.length, shown + 45);
  for (let i = from; i < to; i++) {
    const s = document.createElement('span');
    s.textContent = doc.words[i] + ' ';
    if (i >= shown && i < shown + S.chunk) s.className = 'cur';
    s.onclick = () => seek(i);
    el.append(s);
  }
}
$('context').addEventListener('pointerdown', (e) => e.stopPropagation());
function refreshView() { renderGhost(); renderContext(); }

function renderChapters() {
  const ul = $('chapList');
  ul.textContent = '';
  const ch = doc.chapters || [];
  $('chapHead').hidden = !ch.length;
  ch.forEach((c) => {
    const li = document.createElement('li');
    li.textContent = c.t;
    li.onclick = () => { seek(c.w); closePanels(); };
    ul.append(li);
  });
}
$('btnLibrary').addEventListener('click', renderChapters);

// ---------- sound ----------
let actx = null, noiseSrc = null, noiseGain = null;
function audio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
function tick() {
  const c = audio();
  if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = 900;
  g.gain.setValueAtTime(0.04, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.03);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + 0.04);
}
function startNoise() {
  if (!S.noise) return;
  const c = audio();
  if (!c) return;
  const len = c.sampleRate * 4;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const ch = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; ch[i] = last * 3.5; }
  noiseSrc = c.createBufferSource();
  noiseSrc.buffer = buf;
  noiseSrc.loop = true;
  noiseGain = c.createGain();
  noiseGain.gain.value = 0.25;
  noiseSrc.connect(noiseGain).connect(c.destination);
  noiseSrc.start();
}
function stopNoise() {
  if (!noiseSrc) return;
  try { noiseSrc.stop(); } catch {}
  noiseSrc = noiseGain = null;
}

// ---------- session log + backup ----------
function logSession(words, ms) {
  if (words < 20) return;
  const l = store.get('rsvp.sessions', []);
  l.unshift({ t: doc.title, wpm: Math.round(words / (ms / 60000)), w: words, s: Math.round(ms / 1000), at: Date.now() });
  store.set('rsvp.sessions', l.slice(0, 30));
}

$('btnExport').onclick = async () => {
  const keys = await idbOp('readonly', (s) => s.getAllKeys());
  const texts = {};
  for (const k of keys) texts[k] = await idbOp('readonly', (s) => s.get(k));
  const data = { v: 1, settings: S, lib, stats: store.get('rsvp.stats', {}), sessions: store.get('rsvp.sessions', []), texts };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = 'rsvp-backup.json';
  a.click();
};
$('importIn').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.lib || !d.texts) throw new Error('not a backup file');
    for (const [k, v] of Object.entries(d.texts)) await idbOp('readwrite', (s) => s.put(v, k));
    for (const m of d.lib) if (!lib.some((x) => x.id === m.id)) lib.push(m);
    saveLib();
    if (d.stats) store.set('rsvp.stats', Object.assign(d.stats, store.get('rsvp.stats', {})));
    if (d.sessions) store.set('rsvp.sessions', d.sessions);
    alert('Backup imported.');
    renderLibrary();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
});

// ---------- boot ----------
const SAMPLE = `Rapid serial visual presentation, or RSVP, shows text one word at a time in the same spot on the screen. Because your eyes do not need to travel along the line, a large part of the time normally spent on small eye movements disappears.

The highlighted letter is the optimal recognition point. It sits a little left of the middle of each word, which is where the eye naturally lands when it recognizes a word fastest. By pinning that letter to a fixed position, every word arrives exactly where you are already looking.

Start at a comfortable speed and raise it slowly. Most people can follow three hundred words per minute without effort, and many can reach five or six hundred with practice. Press and hold to read, release to stop, and swipe sideways to jump between sentences.

Comprehension matters more than raw speed. Use the quick check after a passage to see how much you really absorbed, and watch your statistics to find the pace that works for you.`;

async function boot() {
  applySettings();
  if (!lib.length) {
    await addText('Welcome to RSVP Reader', SAMPLE);
    closePanels();
    return;
  }
  const last = store.get('rsvp.last', null);
  await openText(lib.some((m) => m.id === last) ? last : lib[0].id);
}
boot();

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
