import './style.css';
import { ownerClient } from './lib/supabase';
import { requireOwner } from './lib/auth';
import { serverClockOffset, watchTables } from './lib/live';
import { esc } from './lib/dom';
import type { Option, Poll, Result, Stage } from './lib/types';

const db = ownerClient();
const root = document.getElementById('root')!;
const COUNTDOWN_SECONDS = 30;

let stage: Stage | null = null;
let polls: Poll[] = [];
let options: Option[] = []; // options of the poll on stage
let results = new Map<string, Result>();
let clockOffset = 0;
let editingPollId: string | null = null; // null = editor closed, 'new' = creating
let trickle: { timer: number; left: number } | null = null;

await requireOwner(db, root);
mount();

// ---------------------------------------------------------------- layout

function mount() {
  root.innerHTML = `
    <div class="admin">
      <header class="admin-head">
        <h1>Show of Hands <span>Admin</span></h1>
        <nav>
          <a href="present.html" target="soh-projector">Open projector view ↗</a>
          <a href="./" target="soh-phone">Open phone view ↗</a>
          <button type="button" class="link" id="signout">Sign out</button>
        </nav>
      </header>

      <section class="card" id="live"></section>

      <div class="admin-grid">
        <section class="card">
          <h2>Rehearsal</h2>
          <p class="help">Fake voters trickle in so you can practice the reveal. They're flagged as rehearsal votes, shown with a red badge on the projector, and wiped with one click.</p>
          <div class="inline">
            <label>Voters <input type="number" id="sim-n" value="40" min="1" max="500" /></label>
            <label>Over (seconds) <input type="number" id="sim-secs" value="30" min="1" max="600" /></label>
            <button type="button" class="btn" id="sim-start">Start trickle</button>
          </div>
          <p class="help" id="sim-status"></p>
          <button type="button" class="btn btn-ghost" id="sim-wipe">Wipe rehearsal votes</button>
        </section>

        <section class="card">
          <h2>“Built with AI” panel</h2>
          <p class="help">Shown on the projector with <kbd>A</kbd> or the toggle below.</p>
          <label class="switch"><input type="checkbox" id="ai-show" /> Show on projector now</label>
          <div id="ai-rows" class="stat-rows"></div>
          <div class="inline">
            <button type="button" class="btn btn-ghost" id="ai-add">Add stat</button>
            <button type="button" class="btn" id="ai-save">Save stats</button>
          </div>
          <p class="help" id="ai-msg"></p>
        </section>
      </div>

      <section class="card" id="polls"></section>
      <section class="card" id="editor" hidden></section>
    </div>
    <div class="admin-toast" id="toast" role="status"></div>`;

  $('signout').addEventListener('click', async () => { await db.auth.signOut(); location.reload(); });
  $('sim-start').addEventListener('click', toggleTrickle);
  $('sim-wipe').addEventListener('click', wipeRehearsal);
  $('ai-add').addEventListener('click', () => addStatRow('', ''));
  $('ai-save').addEventListener('click', saveStats);
  $('ai-show').addEventListener('change', e => void setStage({ show_built_with_ai: (e.target as HTMLInputElement).checked }));

  root.addEventListener('click', onClick);
  setInterval(renderCountdown, 250);
  void serverClockOffset(db).then(ms => { clockOffset = ms; });

  let statsLoaded = false;
  watchTables({
    client: db,
    tables: ['soh_stage', 'soh_polls', 'soh_options', 'soh_votes'],
    refresh: async () => {
      await refresh();
      if (!statsLoaded && stage) { renderStats(); statsLoaded = true; }
    },
    fallbackMs: 3000,
  });
}

function $(id: string) {
  return document.getElementById(id)!;
}

// ---------------------------------------------------------------- data

async function refresh() {
  const [st, ps] = await Promise.all([
    db.from('soh_stage').select('*').eq('id', 1).maybeSingle<Stage>(),
    db.from('soh_polls').select('id,title,status,blind_mode,winner_option_id,closes_at').order('created_at'),
  ]);
  if (st.error || ps.error) throw st.error ?? ps.error;
  stage = st.data;
  polls = (ps.data ?? []) as Poll[];

  if (stage?.poll_id) {
    const [o, r] = await Promise.all([
      db.from('soh_options').select('*').eq('poll_id', stage.poll_id).order('sort_order'),
      db.rpc('soh_results', { p_poll_id: stage.poll_id }),
    ]);
    if (o.error || r.error) throw o.error ?? r.error;
    options = (o.data ?? []) as Option[];
    results = new Map(((r.data ?? []) as Result[]).map(x => [x.option_id, x]));
  } else {
    options = [];
    results = new Map();
  }
  renderLive();
  renderPolls();
  ($('ai-show') as HTMLInputElement).checked = !!stage?.show_built_with_ai;
}

const livePoll = () => polls.find(p => p.id === stage?.poll_id) ?? null;
const serverNow = () => Date.now() + clockOffset;

// ---------------------------------------------------------------- live controls

function renderLive() {
  const poll = livePoll();
  if (!poll) {
    $('live').innerHTML = `<h2>On stage</h2><p class="help">No poll on stage. Pick one below with “Put on stage”.</p>`;
    return;
  }
  const n = (id: string, k: keyof Result) => Number(results.get(id)?.[k] ?? 0);
  const total = options.reduce((a, o) => a + n(o.id, 'total'), 0);
  const sim = options.reduce((a, o) => a + n(o.id, 'simulated_votes'), 0);
  const counting = poll.status === 'open' && !!poll.closes_at;

  $('live').innerHTML = `
    <div class="live-head">
      <div>
        <h2>On stage: ${esc(poll.title)}</h2>
        <p class="help">
          <span class="chip chip-${poll.status} chip-sm">${{ draft: 'Waiting', open: 'Open', closed: 'Closed', revealed: 'Revealed' }[poll.status]}</span>
          <span class="countdown-sm" id="countdown"></span>
          ${total} ${total === 1 ? 'vote' : 'votes'}${sim ? ` <span class="sim-note">(${sim} rehearsal)</span>` : ''}
          ${poll.blind_mode ? ' · Blind mode on' : ''}
        </p>
      </div>
    </div>
    <div class="controls">
      <button type="button" class="btn" data-act="open" ${poll.status === 'open' || poll.status === 'revealed' ? 'disabled' : ''}>Open voting</button>
      <button type="button" class="btn${counting ? ' btn-ghost' : ''}" data-act="countdown" ${poll.status !== 'open' ? 'disabled' : ''}>${counting ? 'Cancel countdown' : `Close in ${COUNTDOWN_SECONDS}s + reveal`}</button>
      <button type="button" class="btn btn-ghost" data-act="close-now" ${poll.status !== 'open' ? 'disabled' : ''}>Close now</button>
      <button type="button" class="btn" data-act="reveal" ${poll.status === 'draft' || poll.status === 'revealed' ? 'disabled' : ''}>Reveal on projector</button>
      <button type="button" class="btn btn-ghost" data-act="blind">${poll.blind_mode ? 'Show counts' : 'Hide counts (blind)'}</button>
      <button type="button" class="btn btn-danger" data-act="reset">Reset votes</button>
    </div>
    <table class="results">
      <thead><tr><th>Option</th><th>Phones</th><th>Rehearsal</th><th>By hand</th><th>Total</th></tr></thead>
      <tbody>
        ${options.map(o => `
          <tr>
            <td>${esc(o.label)}${poll.winner_option_id === o.id ? ' 🏆' : ''}</td>
            <td>${n(o.id, 'real_votes')}</td>
            <td>${n(o.id, 'simulated_votes')}</td>
            <td class="manual">
              <button type="button" class="step" data-act="manual" data-id="${o.id}" data-delta="-1" aria-label="Remove a hand vote for ${esc(o.label)}" ${o.manual_count === 0 ? 'disabled' : ''}>−</button>
              <span>${o.manual_count}</span>
              <button type="button" class="step" data-act="manual" data-id="${o.id}" data-delta="1" aria-label="Add a hand vote for ${esc(o.label)}">+</button>
              <button type="button" class="step step-wide" data-act="manual-set" data-id="${o.id}">Set…</button>
            </td>
            <td><strong>${n(o.id, 'total')}</strong></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="help">“By hand” is the show-of-hands fallback: count raised hands and type them in. They count toward the total on the projector.</p>`;
  renderCountdown();
}

function renderCountdown() {
  const el = document.getElementById('countdown');
  const poll = livePoll();
  if (!el) return;
  if (poll?.status !== 'open' || !poll.closes_at) { el.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((Date.parse(poll.closes_at) - serverNow()) / 1000));
  el.textContent = `⏱ ${left}s`;
}

async function onClick(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!btn || btn.disabled) return;
  const poll = livePoll();
  const act = btn.dataset.act!;
  const id = btn.dataset.id ?? '';

  switch (act) {
    case 'open':
      return poll && updatePoll(poll.id, { status: 'open', closes_at: null }, 'Voting is open');
    case 'countdown':
      if (!poll) return;
      if (poll.closes_at) return updatePoll(poll.id, { closes_at: null }, 'Countdown cancelled');
      return run(db.rpc('soh_start_countdown', { p_poll_id: poll.id, p_seconds: COUNTDOWN_SECONDS }), `Closing in ${COUNTDOWN_SECONDS}s, then the projector reveals`);
    case 'close-now':
      return poll && updatePoll(poll.id, { status: 'closed', closes_at: null }, 'Voting closed');
    case 'reveal':
      // The projector window runs the animation; we just ask it to.
      if (!stage) return;
      return setStage({ reveal_requests: stage.reveal_requests + 1 }, 'Reveal sent to the projector');
    case 'blind':
      return poll && updatePoll(poll.id, { blind_mode: !poll.blind_mode });
    case 'reset':
      if (!poll || !confirm(`Erase ALL votes (phones, rehearsal and by hand) for “${poll.title}” and set it back to Waiting?`)) return;
      return resetPoll(poll.id);
    case 'manual': {
      const o = options.find(x => x.id === id);
      if (!o) return;
      return run(db.from('soh_options').update({ manual_count: Math.max(0, o.manual_count + Number(btn.dataset.delta)) }).eq('id', id));
    }
    case 'manual-set': {
      const o = options.find(x => x.id === id);
      const raw = o && prompt(`Hand-count votes for “${o.label}”:`, String(o.manual_count));
      if (raw == null || raw === '') return;
      const value = Math.max(0, Math.floor(Number(raw)));
      if (!Number.isFinite(value)) return toast('That isn’t a number');
      return run(db.from('soh_options').update({ manual_count: value }).eq('id', id));
    }
    case 'stage':
      return setStage({ poll_id: id }, 'Poll is on stage');
    case 'edit':
      return openEditor(id);
    case 'new-poll':
      return openEditor('new');
    case 'delete-poll': {
      const p = polls.find(x => x.id === id);
      if (!p || !confirm(`Delete “${p.title}” and all of its votes? This can't be undone.`)) return;
      return run(db.from('soh_polls').delete().eq('id', id), 'Poll deleted');
    }
  }
}

async function resetPoll(pollId: string) {
  const steps = await Promise.all([
    db.from('soh_votes').delete().eq('poll_id', pollId),
    db.from('soh_options').update({ manual_count: 0 }).eq('poll_id', pollId),
    db.from('soh_polls').update({ status: 'draft', winner_option_id: null, closes_at: null }).eq('id', pollId),
  ]);
  const failed = steps.find(s => s.error);
  toast(failed ? `Reset failed: ${failed.error!.message}` : 'Reset: votes erased, back to Waiting');
}

// ---------------------------------------------------------------- polls list + editor

function renderPolls() {
  $('polls').innerHTML = `
    <div class="live-head">
      <h2>Polls</h2>
      <button type="button" class="btn" data-act="new-poll">New poll</button>
    </div>
    <ul class="poll-list">
      ${polls.map(p => `
        <li>
          <span class="poll-title">${esc(p.title)}${p.id === stage?.poll_id ? ' <span class="on-stage">ON STAGE</span>' : ''}</span>
          <span class="poll-actions">
            ${p.id === stage?.poll_id ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-act="stage" data-id="${p.id}">Put on stage</button>`}
            <button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="${p.id}">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" data-act="delete-poll" data-id="${p.id}" ${p.id === stage?.poll_id ? 'disabled title="Take it off stage first"' : ''}>Delete</button>
          </span>
        </li>`).join('') || '<li class="help">No polls yet.</li>'}
    </ul>`;
}

interface DraftOption { id: string | null; label: string; description: string }

async function openEditor(pollId: string) {
  editingPollId = pollId;
  let title = '';
  let rows: DraftOption[] = [{ id: null, label: '', description: '' }, { id: null, label: '', description: '' }];
  if (pollId !== 'new') {
    const p = polls.find(x => x.id === pollId);
    const { data, error } = await db.from('soh_options').select('*').eq('poll_id', pollId).order('sort_order');
    if (error || !p) return toast(`Couldn't load that poll: ${error?.message ?? 'not found'}`);
    title = p.title;
    rows = (data as Option[]).map(o => ({ id: o.id, label: o.label, description: o.description }));
  }
  renderEditor(title, rows);
  $('editor').scrollIntoView({ behavior: 'smooth' });
}

function renderEditor(title: string, rows: DraftOption[]) {
  const editor = $('editor');
  editor.hidden = false;
  editor.innerHTML = `
    <h2>${editingPollId === 'new' ? 'New poll' : 'Edit poll'}</h2>
    <label class="field">Question <input type="text" id="ed-title" maxlength="200" value="${esc(title)}" placeholder="What should I build live?" /></label>
    <ol class="opt-rows" id="ed-rows">
      ${rows.map((r, i) => `
        <li data-id="${r.id ?? ''}">
          <input type="text" class="ed-label" maxlength="80" value="${esc(r.label)}" placeholder="Option name" aria-label="Option ${i + 1} name" />
          <input type="text" class="ed-desc" maxlength="200" value="${esc(r.description)}" placeholder="One-line description (optional)" aria-label="Option ${i + 1} description" />
          <span class="opt-move">
            <button type="button" class="step" data-ed="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="step" data-ed="down" aria-label="Move down" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="step" data-ed="remove" aria-label="Remove option">✕</button>
          </span>
        </li>`).join('')}
    </ol>
    <div class="inline">
      <button type="button" class="btn btn-ghost" data-ed="add">Add option</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" data-ed="cancel">Cancel</button>
      <button type="button" class="btn" data-ed="save">Save poll</button>
    </div>`;

  editor.onclick = e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ed]');
    if (!btn) return;
    const current = readEditor();
    const li = btn.closest('li');
    const i = li ? [...li.parentElement!.children].indexOf(li) : -1;
    switch (btn.dataset.ed) {
      case 'add': current.rows.push({ id: null, label: '', description: '' }); break;
      case 'remove': current.rows.splice(i, 1); break;
      case 'up': [current.rows[i - 1], current.rows[i]] = [current.rows[i], current.rows[i - 1]]; break;
      case 'down': [current.rows[i + 1], current.rows[i]] = [current.rows[i], current.rows[i + 1]]; break;
      case 'cancel': editor.hidden = true; editingPollId = null; return;
      case 'save': void saveEditor(); return;
    }
    renderEditor(current.title, current.rows);
  };
}

function readEditor(): { title: string; rows: DraftOption[] } {
  const title = ($('ed-title') as HTMLInputElement).value;
  const rows = [...$('ed-rows').querySelectorAll('li')].map(li => ({
    id: li.dataset.id || null,
    label: (li.querySelector('.ed-label') as HTMLInputElement).value,
    description: (li.querySelector('.ed-desc') as HTMLInputElement).value,
  }));
  return { title, rows };
}

async function saveEditor() {
  const { title, rows } = readEditor();
  const clean = rows.map(r => ({ ...r, label: r.label.trim(), description: r.description.trim() })).filter(r => r.label);
  if (!title.trim()) return toast('Give the poll a question');
  if (clean.length < 2) return toast('A poll needs at least two options');

  let pollId = editingPollId!;
  if (pollId === 'new') {
    const { data, error } = await db.from('soh_polls').insert({ title: title.trim() }).select('id').single();
    if (error) return toast(`Couldn't create: ${error.message}`);
    pollId = data.id as string;
  } else {
    const { data: existing } = await db.from('soh_options').select('id').eq('poll_id', pollId);
    const keep = new Set(clean.map(r => r.id).filter(Boolean));
    const removed = (existing ?? []).filter(o => !keep.has(o.id)).map(o => o.id as string);
    if (removed.length && !confirm(`Remove ${removed.length} option(s)? Any votes for them are erased.`)) return;
    const steps = await Promise.all([
      db.from('soh_polls').update({ title: title.trim() }).eq('id', pollId),
      removed.length ? db.from('soh_options').delete().in('id', removed) : Promise.resolve({ error: null }),
    ]);
    const failed = steps.find(s => s.error);
    if (failed) return toast(`Couldn't save: ${failed.error!.message}`);
  }

  // Existing options keep their id (and their votes); new ones are inserted.
  const results = await Promise.all(clean.map((r, i) => {
    const fields = { label: r.label, description: r.description, sort_order: i + 1 };
    return r.id
      ? db.from('soh_options').update(fields).eq('id', r.id)
      : db.from('soh_options').insert({ ...fields, poll_id: pollId });
  }));
  const failed = results.find(s => s.error);
  if (failed) return toast(`Couldn't save options: ${failed.error!.message}`);

  if (!stage?.poll_id) await setStage({ poll_id: pollId });
  $('editor').hidden = true;
  editingPollId = null;
  toast('Poll saved');
  await refresh();
}

// ---------------------------------------------------------------- rehearsal

function toggleTrickle() {
  if (trickle) return stopTrickle('Stopped');
  const poll = livePoll();
  if (!poll || !options.length) return toast('Put a poll on stage first');
  const n = clampInt(($('sim-n') as HTMLInputElement).value, 1, 500);
  const secs = clampInt(($('sim-secs') as HTMLInputElement).value, 1, 600);
  // Uneven odds so the race looks real.
  const weights = options.map(() => 0.5 + Math.random());
  const sum = weights.reduce((a, b) => a + b, 0);

  trickle = { timer: 0, left: n };
  $('sim-start').textContent = 'Stop trickle';
  const step = async () => {
    if (!trickle) return;
    let r = Math.random() * sum;
    const option = options[Math.max(0, weights.findIndex(w => (r -= w) < 0))];
    const { error } = await db.from('soh_votes').insert({
      poll_id: poll.id,
      option_id: option.id,
      voter_id: `rehearsal-${crypto.randomUUID()}`,
      is_simulated: true,
    });
    if (error) return stopTrickle(`Stopped: ${error.message}`);
    trickle.left--;
    $('sim-status').textContent = `${n - trickle.left} of ${n} rehearsal votes in…`;
    if (trickle.left <= 0) return stopTrickle(`Done: ${n} rehearsal votes added`);
    // random gaps that average out to the chosen duration
    trickle.timer = window.setTimeout(step, (secs * 1000 / n) * (0.3 + Math.random() * 1.4));
  };
  void step();
}

function stopTrickle(message: string) {
  if (trickle) clearTimeout(trickle.timer);
  trickle = null;
  $('sim-start').textContent = 'Start trickle';
  $('sim-status').textContent = message;
}

async function wipeRehearsal() {
  stopTrickle('');
  const { error, count } = await db.from('soh_votes').delete({ count: 'exact' }).eq('is_simulated', true);
  toast(error ? `Wipe failed: ${error.message}` : `Wiped ${count ?? 0} rehearsal votes`);
}

const clampInt = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v) || min)));

// ---------------------------------------------------------------- built-with-AI stats

function renderStats() {
  $('ai-rows').innerHTML = '';
  const stats = stage?.built_stats?.length ? stage.built_stats : [
    { label: 'Time to build', value: '' },
    { label: 'Prompts', value: '' },
    { label: 'Lines of code I wrote', value: '0' },
  ];
  stats.forEach(s => addStatRow(s.label, s.value));
}

function addStatRow(label: string, value: string) {
  const row = document.createElement('div');
  row.className = 'stat-row';
  row.innerHTML = `
    <input type="text" class="st-label" maxlength="40" placeholder="Label (e.g. Prompts)" value="${esc(label)}" aria-label="Stat label" />
    <input type="text" class="st-value" maxlength="20" placeholder="Value (e.g. 42)" value="${esc(value)}" aria-label="Stat value" />
    <button type="button" class="step" aria-label="Remove stat">✕</button>`;
  row.querySelector('button')!.addEventListener('click', () => row.remove());
  $('ai-rows').appendChild(row);
}

async function saveStats() {
  const stats = [...$('ai-rows').querySelectorAll('.stat-row')].map(r => ({
    label: (r.querySelector('.st-label') as HTMLInputElement).value.trim(),
    value: (r.querySelector('.st-value') as HTMLInputElement).value.trim(),
  })).filter(s => s.label && s.value);
  await setStage({ built_stats: stats }, 'Stats saved');
  $('ai-msg').textContent = `${stats.length} stat${stats.length === 1 ? '' : 's'} saved. Rows missing a label or value are skipped.`;
}

// ---------------------------------------------------------------- helpers

async function updatePoll(id: string, patch: Partial<Poll>, ok?: string) {
  return run(db.from('soh_polls').update(patch).eq('id', id), ok);
}

async function setStage(patch: Partial<Stage>, ok?: string) {
  return run(db.from('soh_stage').update(patch).eq('id', 1), ok);
}

async function run(query: PromiseLike<{ error: { message: string } | null }>, ok?: string) {
  const { error } = await query;
  if (error) toast(`Didn't save: ${error.message}`);
  else if (ok) toast(ok);
}

let toastTimer: number | undefined;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('is-on'), 2600);
}
