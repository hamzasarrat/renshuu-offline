/* Renshuu Offline — runs on app.renshuu.org (loaded by bookmarklet or userscript).
 *  #rso-get          -> download today's due vocab/kanji reviews and hand them to the offline app
 *  #rso-sync:<data>  -> replay offline answers into real Renshuu quizzes
 * Private-use tool. Uses the same requests the Renshuu web quiz makes. */
(function () {
'use strict';

/* ---------------- shared helpers (also used by tests in node) ---------------- */
const VOCAB_VECTORS = ['Kanji > Kana', 'Kana > Kanji', 'Kanji > Meaning', 'Meaning > Kanji', 'Kana > Meaning', 'Meaning > Kana'];
const KANJI_VECTORS = ['Definition', 'Onyomi', 'Kunyomi'];

function meaningLabel(defs) {
  if (!defs || !defs.length) return '';
  return defs.length > 1 ? defs.map((d, i) => (i + 1) + '. ' + d).join('; ') : defs[0];
}
function normJa(s) {
  return String(s || '').replace(/\([^)]*\)/g, '').replace(/[\s　]+/g, '').trim();
}
function normEn(s) {
  return String(s || '').toLowerCase()
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(^|[\s;])\d+\.\s/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
function enMatch(a, b) {
  const x = normEn(a), y = normEn(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y, long = x.length < y.length ? y : x;
  // choice labels can be truncated; question text has POS appended (removed by paren strip)
  return short.length >= 8 && long.startsWith(short);
}
function splitReadings(s) {
  return String(s || '').split(/[,、]/).map(x => x.trim()).filter(Boolean);
}
// prompt/answer pairs for one item+vector. kind: 'ja' | 'en' for comparison mode
function pairFor(it, v) {
  if (it.t === 'v') {
    const K = it.K || it.H, H = it.H, M = meaningLabel(it.D);
    switch (v) {
      case 'Kanji > Kana': return { p: [K], pk: 'ja', a: [H], ak: 'ja' };
      case 'Kana > Kanji': return { p: [H], pk: 'ja', a: [K], ak: 'ja' };
      case 'Kanji > Meaning': return { p: [K], pk: 'ja', a: [M], ak: 'en' };
      case 'Meaning > Kanji': return { p: [M], pk: 'en', a: [K], ak: 'ja' };
      case 'Kana > Meaning': return { p: [H], pk: 'ja', a: [M], ak: 'en' };
      case 'Meaning > Kana': return { p: [M], pk: 'en', a: [H], ak: 'ja' };
    }
  } else if (it.t === 'k') {
    switch (v) {
      case 'Definition': return { p: [it.C], pk: 'ja', a: [it.D], ak: 'en' };
      case 'Onyomi': return { p: it.on, pk: 'ja', a: [it.C], ak: 'ja' };
      case 'Kunyomi': return { p: it.kun, pk: 'ja', a: [it.C], ak: 'ja' };
    }
  }
  return null;
}
function eq(kind, a, b) { return kind === 'ja' ? (normJa(a) !== '' && normJa(a) === normJa(b)) : enMatch(a, b); }

/* q = {kind:'mc', prompt:'...', choices:[{value,label}]}
 * items = all pack items of the schedule. Returns {status:'ok', item, v, choice} | {status:'none'} | {status:'ambiguous'} */
function matchQuestion(q, items) {
  if (!q || q.kind !== 'mc') return { status: 'none' };
  const found = [];
  for (const it of items) {
    const vecs = it.t === 'v' ? VOCAB_VECTORS : KANJI_VECTORS;
    for (const v of vecs) {
      const pr = pairFor(it, v);
      if (!pr) continue;
      if (!pr.p.some(p => eq(pr.pk, q.prompt, p))) continue;
      const ch = q.choices.filter(c => pr.a.some(a => eq(pr.ak, c.label, a)));
      if (ch.length === 1) found.push({ item: it, v, choice: ch[0] });
    }
  }
  if (!found.length) return { status: 'none' };
  // de-duplicate identical item+vector
  const uniq = [];
  for (const f of found) if (!uniq.some(u => u.item.id === f.item.id && u.item.t === f.item.t && u.v === f.v)) uniq.push(f);
  if (uniq.length === 1) return Object.assign({ status: 'ok' }, uniq[0]);
  // several candidates (e.g. homophones). Fine only if all point to the same choice AND the same item.
  const sameItem = uniq.every(u => u.item.id === uniq[0].item.id && u.item.t === uniq[0].item.t);
  const sameChoice = uniq.every(u => u.choice.value === uniq[0].choice.value);
  if (sameItem && sameChoice) {
    // prompt + answer identical across vectors (e.g. kana-only word): ask caller to pick the vector with a result
    return { status: 'ok', item: uniq[0].item, v: uniq[0].v, choice: uniq[0].choice, alts: uniq.map(u => u.v) };
  }
  return { status: 'ambiguous', cands: uniq };
}

// Parse the quiz HTML (rquiz_body) into a question. Needs a DOM (browser) — makeDiv injected for tests.
function parseQuizBody(html, makeDiv) {
  const d = makeDiv(html || '');
  d.querySelectorAll('script,style').forEach(s => s.remove());
  const form = d.querySelector('#run_quiz');
  const correctShown = !!d.querySelector('.correctbox');
  const wrongShown = !!d.querySelector('.incorrectbox,.wrongbox,.missbox');
  if (!form) return { kind: 'end', correctShown, wrongShown, text: (d.textContent || '').replace(/\s+/g, ' ').slice(0, 300) };
  const qnum = (d.querySelector('#qnum') || {}).value;
  const qb = d.querySelector('#questionbox');
  const prompt = qb ? qb.textContent.replace(/\s+/g, ' ').trim() : '';
  const radios = [...form.querySelectorAll('input[type=radio][name=answer]')];
  const label = (d.querySelector('#qlabel_box') || {}).textContent || '';
  if (!radios.length || qnum == null) {
    return { kind: 'other', qnum, prompt, label, correctShown, wrongShown };
  }
  const choices = [];
  let skipValue = null;
  for (const r of radios) {
    if (r.value === '(skipped)') { skipValue = r.value; continue; }
    const lab = d.querySelector('#' + r.id + 'label');
    choices.push({ value: r.value, label: lab ? lab.textContent.replace(/\s+/g, ' ').trim() : '' });
  }
  return { kind: 'mc', qnum, prompt, label, choices, skipValue: skipValue || '(skipped)', correctShown, wrongShown };
}

async function b64Encode(obj) {
  const s = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(s).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function b64Decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const buf = Uint8Array.from(bin, c => c.charCodeAt(0));
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(s).text());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchQuestion, parseQuizBody, pairFor, meaningLabel, normEn, normJa, enMatch, b64Encode, b64Decode, VOCAB_VECTORS, KANJI_VECTORS };
  return;
}

/* ---------------- browser part ---------------- */
if (!/(^|\.)renshuu\.org$/.test(location.hostname)) {
  alert('Renshuu Offline: open app.renshuu.org first, then run this bookmark.');
  return;
}
if (location.hostname !== 'app.renshuu.org') {
  location.href = 'https://app.renshuu.org/me' + location.hash;
  return;
}

const SRC = (document.currentScript && document.currentScript.src) || window.__RSO_SRC || '';
const APP_URL = SRC ? new URL('./', SRC).href.split('?')[0] : (window.__RSO_APP || '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const makeDiv = html => { const d = document.createElement('div'); d.innerHTML = html; return d; };
const XH = { 'X-Requested-With': 'XMLHttpRequest' };
function rpost(page, data) {
  return fetch('/index.php?page=' + page, {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, XH),
    body: new URLSearchParams(data)
  }).then(r => { if (!r.ok) throw new Error(page + ' HTTP ' + r.status); return r.text(); });
}
function rget(page) {
  return fetch('/index.php?page=' + page, { credentials: 'include', headers: XH })
    .then(r => { if (!r.ok) throw new Error(page + ' HTTP ' + r.status); return r.text(); });
}
function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); }
function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(offset) { const d = new Date(); d.setDate(d.getDate() + (offset || 0)); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()); }

/* ---------- panel UI ---------- */
const old = document.getElementById('rso-panel');
if (old) old.remove();
const panel = document.createElement('div');
panel.id = 'rso-panel';
panel.innerHTML = `
<style>
#rso-panel{position:fixed;inset:0;z-index:2147483646;background:rgba(10,12,18,.92);color:#eef;font:15px/1.45 system-ui,sans-serif;overflow:auto;-webkit-text-size-adjust:100%}
#rso-panel .w{max-width:560px;margin:0 auto;padding:18px 16px 40px}
#rso-panel h2{margin:4px 0 12px;font-size:20px}
#rso-panel button,#rso-panel a.b{display:inline-block;background:#3b82c4;color:#fff;border:0;border-radius:10px;padding:11px 16px;font-size:15px;margin:6px 6px 6px 0;text-decoration:none;cursor:pointer}
#rso-panel button.g{background:#444b5a}
#rso-panel button:disabled{opacity:.5}
#rso-panel .log{background:#141821;border-radius:10px;padding:10px;margin-top:12px;font:12.5px/1.5 ui-monospace,monospace;white-space:pre-wrap;max-height:50vh;overflow:auto}
#rso-panel .card{background:#1c2130;border-radius:12px;padding:12px;margin:10px 0}
#rso-panel select{font-size:15px;padding:6px;border-radius:8px}
#rso-panel .x{float:right;background:#444b5a}
#rso-panel .ok{color:#7ddc8a}#rso-panel .bad{color:#ff8a80}#rso-panel .dim{color:#9aa3b5}
</style>
<div class="w"><button class="x" id="rso-close">Close</button><h2>Renshuu Offline</h2><div id="rso-body"></div><div class="log" id="rso-log" style="display:none"></div></div>`;
document.body.appendChild(panel);
const $ = s => panel.querySelector(s);
$('#rso-close').onclick = () => { if (!busy || confirm('Stop and close?')) { stopFlag = true; panel.remove(); } };
let busy = false, stopFlag = false;
function log(msg, cls) {
  const l = $('#rso-log'); l.style.display = 'block';
  const line = document.createElement('div'); if (cls) line.className = cls; line.textContent = msg;
  l.appendChild(line); l.scrollTop = l.scrollHeight;
}
function body(html) { $('#rso-body').innerHTML = html; }

/* ---------- API (prep) ---------- */
let apiKey = null;
async function getApiKey() {
  if (apiKey) return apiKey;
  const h = await rget('misc/api');
  const cands = [...new Set(h.match(/[A-Za-z0-9_\-]{64}/g) || [])];
  for (const c of cands) {
    const r = await fetch('https://api.renshuu.org/v1/profile', { headers: { Authorization: 'Bearer ' + c } });
    if (r.ok) { apiKey = c; return c; }
  }
  throw new Error('Could not find your API key on Tools → Renshuu API. Open that page once to generate it, then retry.');
}
async function api(path) {
  const key = await getApiKey();
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.renshuu.org/v1' + path, { headers: { Authorization: 'Bearer ' + key } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error('API ' + path + ' → ' + r.status);
  }
  throw new Error('API ' + path + ' kept failing');
}

function toItem(sched, t, limit) {
  const vecs = (t.user_data && t.user_data.study_vectors) || {};
  const supported = sched.type === 'vocab' ? VOCAB_VECTORS : KANJI_VECTORS;
  const due = [], unsupportedDue = [];
  for (const name of Object.keys(vecs)) {
    const v = vecs[name];
    if (!v || v.last_quizzed === 'Not yet' || !v.next_quiz || v.next_quiz > limit) continue;
    (supported.includes(name) ? due : unsupportedDue).push(name);
  }
  let it;
  if (sched.type === 'vocab') {
    it = { s: sched.id, t: 'v', id: t.id, K: t.kanji_full || '', H: t.hiragana_full || '', D: t.def || [], p: t.typeofspeech || '', pi: (t.pitch && t.pitch[0]) || '' };
    // kana-only words: Renshuu shows kana where kanji would be
    if (!it.K) it.K = it.H;
  } else {
    it = { s: sched.id, t: 'k', id: t.id, C: t.kanji, on: splitReadings(t.onyomi), kun: splitReadings(t.kunyomi), D: t.definition || '', sc: t.scount, rad: t.radical || '' };
    // *_marked: "bカイ,hエ" — 'b' = main readings Renshuu quizzes on
    const main = m => splitReadings(m).filter(x => x[0] === 'b').map(x => x.slice(1));
    it.onB = main(t.onyomi_marked); it.kunB = main(t.kunyomi_marked);
  }
  it.v = due;
  return { it, unsupportedDue };
}

async function doPrep(ahead, chosen) {
  busy = true;
  try {
    const limit = dayStr(ahead);
    log('Reading your schedules…');
    const sch = await api('/schedule');
    const pack = { v: 1, id: uuid().slice(0, 8), created: new Date().toISOString(), day: dayStr(0), limit, schedules: [], items: [], notes: [] };
    for (const s of (sch.schedules || [])) {
      const type = s.booktype === 'vocab' ? 'vocab' : s.booktype === 'kanji' ? 'kanji' : null;
      const today = s.today || {};
      if (!chosen.includes(String(s.id))) continue;
      if (!type) {
        if (today.review) pack.notes.push(`${s.name}: ${today.review} reviews (${s.booktype} — not available offline, do these online)`);
        continue;
      }
      const sched = { id: s.id, name: s.name, type };
      const group = ahead > 0 ? 'studied' : 'review_today';
      let pg = 1, total = 1, nItems = 0, nVec = 0, unsupportedTerms = 0;
      do {
        if (stopFlag) throw new Error('stopped');
        const r = await api(`/schedule/${s.id}/list?group=${group}&pg=${pg}`);
        const c = r.contents || {};
        total = c.total_pg || 1;
        for (const t of (c.terms || [])) {
          const { it, unsupportedDue } = toItem(sched, t, limit);
          if (unsupportedDue.length && !it.v.length) unsupportedTerms++;
          if (it.v.length) { pack.items.push(it); nItems++; nVec += it.v.length; }
        }
        log(`  ${s.name}: page ${pg}/${total}`, 'dim');
        pg++;
        await sleep(250);
      } while (pg <= total);
      sched.count = nItems; sched.vectors = nVec;
      pack.schedules.push(sched);
      log(`${s.name}: ${nItems} items, ${nVec} questions`, 'ok');
      if (unsupportedTerms) pack.notes.push(`${s.name}: ${unsupportedTerms} items only due in quiz types not available offline (listening, writing…)`);
    }
    const data = await b64Encode(pack);
    log(`Pack ready (${Math.round(data.length / 1024)} KB). Opening the offline app…`, 'ok');
    if (!APP_URL) throw new Error('Unknown app address; run this from the bookmark created by the app.');
    body(`<div class="card">Pack ready: <b>${pack.items.length}</b> items. If the app didn't open, <a class="b" href="${APP_URL}#pack:${data}">open the offline app</a></div>`);
    if (window.__RSO_TEST) { window.__RSO_LASTPACK = data; return; }
    await sleep(600);
    location.href = APP_URL + '#pack:' + data;
  } catch (e) {
    log('Error: ' + e.message, 'bad');
  } finally { busy = false; }
}

/* ---------- Sync ---------- */
async function startQuiz(sid) {
  const a = JSON.parse(await rpost('quiz/setup_quiz', { sched_id: String(sid), href: 'https://app.renshuu.org/me', direct: '1' }));
  if (!a.redirect || !/run_quiz/.test(a.redirect)) throw new Error('Could not start quiz (' + JSON.stringify(a).slice(0, 120) + ')');
  await rget('quiz/run_quiz&ajax=true&br_dark=1');
  const j = JSON.parse(await rpost('quiz/run_quiz_ajax', { br_dark: '1' }));
  return j;
}
async function finishQuiz() { try { await rget('quiz/finish&ajax=true&br_dark=1'); } catch (e) { } }

async function doSync(payload) {
  busy = true; stopFlag = false;
  const consumed = new Set();         // result ids already sent
  const byKey = new Map();            // "s|t|id|v" -> [results]
  for (const r of payload.results) {
    const k = r.s + '|' + r.t + '|' + r.i + '|' + r.v;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const answeredKeys = new Set();     // keys answered in this run (repeats in same quiz get the correct answer)
  const stats = { right: 0, wrong: 0 };
  const schedIds = [...new Set(payload.results.map(r => r.s))];
  try {
    for (const sid of schedIds) {
      const items = payload.items.filter(it => it.s === sid);
      const name = (payload.schedules.find(s => s.id === sid) || {}).name || sid;
      const remaining = () => payload.results.filter(r => r.s === sid && !consumed.has(r.r)).length;
      log(`— ${name}: ${remaining()} answers to send`);
      let noProgress = 0, rounds = 0;
      while (remaining() > 0 && noProgress < 3 && rounds < 40 && !stopFlag) {
        rounds++;
        let resp = await startQuiz(sid);
        let q = parseQuizBody(resp.rquiz_body, makeDiv);
        let sentThisRound = 0, stopReason = '';
        while (!stopFlag) {
          if (q.kind !== 'mc') { stopReason = q.kind === 'end' ? 'quiz finished' : 'unsupported question type'; break; }
          const m = matchQuestion(q, items);
          if (m.status !== 'ok') { stopReason = m.status === 'ambiguous' ? 'ambiguous question “' + q.prompt.slice(0, 30) + '”' : 'question not done offline: “' + q.prompt.slice(0, 30) + '”'; break; }
          // pick result for this item+vector (or an alt vector when prompt/answer are identical)
          const vecs = m.alts || [m.v];
          let key = null, res = null;
          for (const v of vecs) {
            const k = sid + '|' + m.item.t + '|' + m.item.id + '|' + v;
            const list = byKey.get(k) || [];
            const r = list.find(x => !consumed.has(x.r));
            if (r) { key = k; res = r; break; }
            if (answeredKeys.has(k)) { key = k; }
          }
          let wantCorrect, el;
          if (res) { wantCorrect = !!res.ok; el = Math.max(2, Math.min(120, res.e || 8)); }
          else if (key && answeredKeys.has(key)) { wantCorrect = true; el = 4; }   // Renshuu re-asking a missed item in the same quiz
          else { stopReason = 'question not done offline: “' + q.prompt.slice(0, 30) + '”'; break; }
          const answer = wantCorrect ? m.choice.value : q.skipValue;
          const now = Math.floor(Date.now() / 1000);
          const raw = await rpost('quiz/run_quiz_ajax', { timestart: String(now - el), elapsed: String(el), qnum: String(q.qnum), answer, randId: uuid(), initialGrab: '0', br_dark: '1' });
          let j;
          try { j = JSON.parse(raw); } catch (e) { throw new Error('Unexpected server reply: ' + raw.slice(0, 120)); }
          const body = j.rquiz_body || '';
          const correctShown = /class=['"][^'"]*\bcorrectbox\b/.test(body);
          if (res) { consumed.add(res.r); }
          answeredKeys.add(key);
          sentThisRound++;
          if (wantCorrect) stats.right++; else stats.wrong++;
          log(`${wantCorrect ? '✓' : '✗'} ${m.item.t === 'v' ? (m.item.K || m.item.H) : m.item.C}  [${m.v}]`, wantCorrect ? 'ok' : 'bad');
          if (wantCorrect && !correctShown) {
            throw new Error('Renshuu did not accept an answer that should be correct — stopping to be safe.');
          }
          if (j.preload) { try { await rget('quiz/run_quiz_preload&br_dark=1'); } catch (e) { } }
          if (j.redirect) { q = { kind: 'end' }; break; }
          q = parseQuizBody(body, makeDiv);
          await sleep(350 + Math.random() * 300);
        }
        await finishQuiz();
        if (stopReason && remaining() > 0) log(`  (round ${rounds}: ${stopReason}; restarting)`, 'dim');
        noProgress = sentThisRound ? 0 : noProgress + 1;
        await sleep(500);
      }
      const left = remaining();
      if (left) log(`${name}: ${left} answers not matched (they'll stay in the app; do those items online)`, 'dim');
    }
  } catch (e) {
    log('Error: ' + e.message, 'bad');
  } finally {
    busy = false;
  }
  const ids = [...consumed];
  log(`Done: ${stats.right} correct and ${stats.wrong} missed answers recorded on Renshuu.`, 'ok');
  try { localStorage.setItem('rso.lastSynced', JSON.stringify({ at: Date.now(), ids })); } catch (e) { }
  const back = APP_URL ? APP_URL + '#synced:' + (await b64Encode(ids)) : '';
  body(`<div class="card"><b>${ids.length}</b> of ${payload.results.length} offline answers sent.<br>
    ${back ? `<a class="b" href="${back}">Back to the offline app</a> <span class="dim">(clears the sent answers there)</span>` : ''}
    <button class="g" onclick="location.href='/me'">Renshuu home</button></div>`);
}

/* ---------- entry ---------- */
async function main() {
  const h = location.hash || '';
  if (h.startsWith('#rso-sync:')) {
    let payload;
    try { payload = await b64Decode(h.slice('#rso-sync:'.length)); }
    catch (e) { body('<div class="card bad">Could not read the data from the app. Go back and tap “Send to Renshuu” again.</div>'); return; }
    const n = payload.results.length, right = payload.results.filter(r => r.ok).length;
    const names = [...new Set(payload.results.map(r => r.s))].map(id => (payload.schedules.find(s => s.id === id) || {}).name || id);
    body(`<div class="card">Ready to send <b>${n}</b> offline answers (${right} correct, ${n - right} missed) for: ${names.join(', ')}.<br>
      <span class="dim">This answers real Renshuu quizzes for you, exactly as you answered offline. Keep this tab open until it finishes.</span></div>
      <button id="rso-go">Send to Renshuu</button>`);
    $('#rso-go').onclick = () => { $('#rso-go').disabled = true; history.replaceState(null, '', '/me'); doSync(payload); };
    return;
  }
  if (h === '#rso-get') history.replaceState(null, '', '/me');
  body('<div class="card dim">Loading your schedules…</div>');
  let scheds;
  try { scheds = ((await api('/schedule')).schedules || []).filter(s => s.booktype === 'vocab' || s.booktype === 'kanji'); }
  catch (e) { body(`<div class="card bad">${e.message}</div>`); return; }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('rso.scheds') || 'null'); } catch (e) { }
  // default: 空の向こえ only if present, else everything
  if (!saved) { const d = scheds.filter(s => s.name === '空の向こえ'); saved = (d.length ? d : scheds).map(s => String(s.id)); }
  body(`<div class="card">Download reviews to study offline (vocabulary and kanji schedules):
    ${scheds.map(s => `<label style="display:block;margin:8px 0"><input type="checkbox" class="rso-s" value="${s.id}" ${saved.includes(String(s.id)) ? 'checked' : ''}> ${s.name} <span class="dim">— ${(s.today || {}).review || 0} to review</span></label>`).join('')}
    <div style="margin-top:10px">Include reviews due up to <select id="rso-ahead"><option value="0">today</option><option value="1">tomorrow</option><option value="2">in 2 days</option><option value="3">in 3 days</option></select></div></div>
    <button id="rso-prep">Download reviews</button>
    ${APP_URL ? `<a class="b" style="background:#444b5a" href="${APP_URL}">Open offline app</a>` : ''}`);
  $('#rso-prep').onclick = () => {
    const chosen = [...panel.querySelectorAll('.rso-s:checked')].map(x => x.value);
    if (!chosen.length) { log('Pick at least one schedule.', 'bad'); return; }
    try { localStorage.setItem('rso.scheds', JSON.stringify(chosen)); } catch (e) { }
    $('#rso-prep').disabled = true;
    doPrep(parseInt($('#rso-ahead').value, 10) || 0, chosen);
  };
}
main();
})();
