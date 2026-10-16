import './style.css';
import QRCode from 'qrcode';
import { esc } from './lib/dom';
import type { Option, Poll, PollStatus, PresenterApi, Question, Result, Stage } from './lib/types';

const root = document.getElementById('root')!;
const joinUrl = new URL(import.meta.env.BASE_URL, location.origin).href;
const joinUrlShort = joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

let stage: Stage | null = null;
let poll: Poll | null = null;
let options: Option[] = [];
let results = new Map<string, Result>();
let questions: Question[] = [];
let revealing = false;
let resetArmedUntil = 0;
let clockOffset = 0; // add to Date.now() to get database time
let autoRevealFor: string | null = null; // the deadline we've already auto-revealed for

const COUNTDOWN_SECONDS = 30;
const shown = new Map<string, number>(); // the count each row is currently displaying

const STATUS_LABEL: Record<PollStatus, string> = { draft: 'Waiting', open: 'Open', closed: 'Closed', revealed: 'Revealed' };

const SHORTCUTS: [string, string][] = [
  ['O', 'Open voting'],
  ['C', `Close in ${COUNTDOWN_SECONDS}s, then reveal (C again cancels)`],
  ['Shift C', 'Close voting right now'],
  ['R', 'Reveal the winner (closes voting first)'],
  ['B', 'Blind mode on/off (hide counts)'],
  ['Q', 'Switch between the poll and Q&A'],
  ['N', 'Q&A: next question (marks the current one answered)'],
  ['A', '"Built with AI" panel on/off'],
  ['F', 'Full screen on/off'],
  ['X X', 'Reset all votes (press twice)'],
  ['? or H', 'This cheat sheet'],
  ['Esc', 'Close panels'],
];

// ?demo uses fake in-memory data for testing and rehearsal. Dev server only.
const demo = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
const api: PresenterApi = demo ? (await import('./lib/demoApi')).demoApi() : await connect();
mount();

async function connect(): Promise<PresenterApi> {
  const [{ ownerClient }, { requireOwner }, { supabaseApi }] = await Promise.all([
    import('./lib/supabase'), import('./lib/auth'), import('./lib/presenterApi'),
  ]);
  const db = ownerClient();
  await requireOwner(db, root);
  return supabaseApi(db);
}

// ---------------------------------------------------------------- layout

function mount() {
  root.innerHTML = `
    <div class="screen" id="screen">
      <header class="s-head">
        <h1 class="s-title" id="title"></h1>
        <span class="countdown" id="countdown" hidden></span>
        <span class="chip" id="status"></span>
      </header>
      <div class="s-body">
        <div class="s-bars" id="bars"></div>
        <div class="s-qa" id="qa"></div>
        <aside class="s-join" id="join">
          <div class="qr" id="qr" role="img" aria-label="QR code to vote"></div>
          <p class="join-hint" id="join-hint">Scan to vote</p>
          <p class="join-url">${esc(joinUrlShort)}</p>
        </aside>
      </div>
      <footer class="s-foot">
        <span class="total" id="total"></span>
        <span class="badge badge-blind" id="blind">Counts hidden until the reveal</span>
        <span class="badge badge-sim" id="sim" hidden></span>
        <span class="foot-right">
          <button type="button" class="stage-btn" id="stage-btn" hidden></button>
          <span class="conn-dot" id="conn" title="Live connection"></span>
          <span class="foot-hint">Press ? for shortcuts</span>
        </span>
      </footer>
      <div class="overlay" id="ai" hidden></div>
      <div class="overlay" id="cheats" hidden>
        <div class="panel">
          <h2>Keyboard shortcuts</h2>
          <dl class="cheats">${SHORTCUTS.map(([k, d]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(d)}</dd>`).join('')}</dl>
        </div>
      </div>
      <div class="toast" id="toast" role="status"></div>
      <div class="confetti" id="confetti" aria-hidden="true"></div>
    </div>`;

  QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
    .then(svg => { $('qr').innerHTML = svg; });

  api.watch(refresh, live => $('conn').classList.toggle('is-down', !live));
  void api.clockOffset().then(ms => { clockOffset = ms; });
  setInterval(tick, 200);

  $('stage-btn').addEventListener('click', e => {
    (e.currentTarget as HTMLElement).blur(); // so Space/Enter don't re-trigger it
    const step = stageStep();
    if (step) void step.run();
  });
}

function $(id: string) {
  return document.getElementById(id)!;
}

// ---------------------------------------------------------------- data

let seenRevealRequests: number | null = null; // baseline from first load, so old requests don't replay

async function refresh() {
  const snap = await api.load();
  stage = snap.stage;
  poll = snap.poll;
  options = snap.options;
  results = new Map(snap.results.map(x => [x.option_id, x]));
  questions = snap.questions;
  render();

  // The admin page asked for a reveal (its "Reveal on projector" button).
  const requests = stage?.reveal_requests ?? 0;
  if (seenRevealRequests === null) seenRevealRequests = requests;
  else if (requests > seenRevealRequests) {
    seenRevealRequests = requests;
    void reveal();
  }
}

const totalFor = (id: string) => Number(results.get(id)?.total ?? 0);

// ---------------------------------------------------------------- render

function render() {
  const qa = stage?.mode === 'qa';
  $('screen').classList.toggle('is-qa', qa);
  $('join-hint').textContent = qa ? 'Scan to ask a question' : 'Scan to vote';
  $('status').hidden = qa;
  if (qa) renderQa();
  else renderPoll();

  const step = stageStep();
  const btn = $('stage-btn');
  btn.hidden = !step;
  if (step) btn.innerHTML = `${esc(step.label)} <kbd>${esc(step.key)}</kbd>`;
  btn.classList.toggle('is-cancel', !!step && step.key === 'C' && countdownActive());

  renderAiPanel();
  tick();
}

function renderPoll() {
  const screen = $('screen');
  if (!poll) {
    $('title').textContent = 'No poll selected';
    $('bars').innerHTML = '<p class="empty">Pick a poll on the admin page.</p>';
    return;
  }

  const blind = poll.blind_mode && poll.status !== 'revealed' && !revealing;
  const revealed = poll.status === 'revealed';
  screen.classList.toggle('is-blind', blind);
  screen.classList.toggle('is-revealed', revealed || revealing);

  $('title').textContent = poll.title;
  const chip = $('status');
  chip.textContent = STATUS_LABEL[poll.status];
  chip.className = `chip chip-${poll.status}`;

  const totals = options.map(o => totalFor(o.id));
  const total = totals.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...totals);
  $('total').innerHTML = `<strong>${total}</strong> ${total === 1 ? 'vote' : 'votes'}`;
  $('blind').hidden = !blind;

  const sim = [...results.values()].reduce((a, r) => a + Number(r.simulated_votes), 0);
  $('sim').hidden = sim === 0;
  $('sim').textContent = `Includes ${sim} rehearsal ${sim === 1 ? 'vote' : 'votes'}`;

  // Keyed rows so bars animate instead of being rebuilt.
  const bars = $('bars');
  bars.querySelector('.empty')?.remove();
  const wanted = new Set(options.map(o => o.id));
  bars.querySelectorAll<HTMLElement>('.row').forEach(row => { if (!wanted.has(row.dataset.id!)) row.remove(); });
  options.forEach((o, i) => {
    let row = bars.querySelector<HTMLElement>(`.row[data-id="${o.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'row';
      row.dataset.id = o.id;
      row.innerHTML = `
        <div class="row-text"><span class="row-label"></span><span class="row-desc"></span></div>
        <div class="track"><div class="fill"></div></div>
        <span class="row-count">0</span>`;
      shown.set(o.id, 0);
    }
    bars.appendChild(row); // keeps sort order
    row.style.setProperty('--bar', `var(--bar-${(i % 4) + 1})`);
    row.querySelector('.row-label')!.textContent = o.label;
    row.querySelector('.row-desc')!.textContent = o.description;
    const n = totalFor(o.id);
    (row.querySelector('.fill') as HTMLElement).style.width = blind ? '0%' : `${(n / max) * 100}%`;
    tweenCount(row, o.id, blind ? null : n);
    if (!revealing) row.classList.toggle('is-winner', revealed && poll!.winner_option_id === o.id);
    if (!revealing) row.classList.toggle('is-loser', revealed && poll!.winner_option_id !== o.id);
  });
}

// ---------------------------------------------------------------- Q&A mode

/** The question on screen right now, if it's still approved. */
function featuredQuestion() {
  return questions.find(q => q.id === stage?.onscreen_question_id && q.status === 'approved') ?? null;
}

/** Approved questions waiting their turn, most upvoted first. */
function questionQueue() {
  const featured = featuredQuestion();
  return questions
    .filter(q => q.status === 'approved' && q.id !== featured?.id)
    .sort((a, b) => b.upvotes - a.upvotes || a.created_at.localeCompare(b.created_at));
}

function renderQa() {
  const featured = featuredQuestion();
  const queue = questionQueue();
  $('title').textContent = 'Questions from the room';
  const approved = queue.length + (featured ? 1 : 0);
  $('total').innerHTML = `<strong>${approved}</strong> ${approved === 1 ? 'question' : 'questions'}`;
  $('blind').hidden = true;
  $('sim').hidden = true;

  const votes = (n: number) => `<span class="qa-votes"><span aria-hidden="true">▲</span> ${n}</span>`;
  $('qa').innerHTML = `
    ${featured ? `
      <div class="qa-featured">
        <p class="qa-kicker">Now answering</p>
        <p class="qa-featured-body">${esc(featured.body)}</p>
        ${votes(featured.upvotes)}
      </div>` : ''}
    ${queue.length ? `
      <ol class="qa-list">
        ${queue.slice(0, featured ? 3 : 5).map(q => `<li>${votes(q.upvotes)}<span class="qa-body">${esc(q.body)}</span></li>`).join('')}
      </ol>` : ''}
    ${!featured && !queue.length ? '<p class="empty">Scan the code and ask away. Questions appear here once approved.</p>' : ''}`;
}

/** N: mark the current question answered and put the top one on screen. */
async function nextQuestion() {
  if (stage?.mode !== 'qa') return;
  const featured = featuredQuestion();
  if (featured) {
    const error = await api.updateQuestion(featured.id, { status: 'answered' });
    if (error) return toast(`Didn't save: ${error}`);
  }
  const next = questionQueue()[0];
  await setStage({ onscreen_question_id: next?.id ?? null });
  if (!next) toast('No more questions in the queue');
}

function toggleQa() {
  return setStage({ mode: stage?.mode === 'qa' ? 'poll' : 'qa' });
}

/** The one next thing the presenter would do, for the on-screen button. */
function stageStep(): { label: string; key: string; run: () => unknown } | null {
  if (stage?.mode === 'qa') {
    if (questionQueue().length) return { label: featuredQuestion() ? 'Next question' : 'Show top question', key: 'N', run: nextQuestion };
    return featuredQuestion() ? { label: 'Done with this one', key: 'N', run: nextQuestion } : null;
  }
  if (!poll || revealing) return null;
  if (poll.status === 'draft') return { label: 'Open voting', key: 'O', run: openVoting };
  if (poll.status === 'open') {
    return countdownActive()
      ? { label: 'Cancel countdown', key: 'C', run: countdownKey }
      : { label: `Close in ${COUNTDOWN_SECONDS}s`, key: 'C', run: countdownKey };
  }
  if (poll.status === 'closed') return { label: 'Reveal winner', key: 'R', run: reveal };
  return null;
}

const serverNow = () => Date.now() + clockOffset;

function countdownActive() {
  return poll?.status === 'open' && !!poll.closes_at;
}

/** Updates the countdown display; at zero, closes voting and reveals. */
function tick() {
  const el = $('countdown');
  if (!countdownActive() || revealing) {
    el.hidden = true;
    return;
  }
  const deadline = poll!.closes_at!;
  const left = Math.max(0, Math.ceil((Date.parse(deadline) - serverNow()) / 1000));
  el.hidden = false;
  el.textContent = `${left}s`;
  el.classList.toggle('is-urgent', left <= 10);
  if (left === 0 && autoRevealFor !== deadline) {
    autoRevealFor = deadline;
    void reveal();
  }
}

function tweenCount(row: HTMLElement, id: string, target: number | null) {
  const el = row.querySelector<HTMLElement>('.row-count')!;
  if (target === null) { el.textContent = '?'; return; }
  const from = shown.get(id) ?? 0;
  if (from === target) { el.textContent = String(target); return; }
  shown.set(id, target);
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / 700);
    el.textContent = String(Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderAiPanel() {
  const panel = $('ai');
  panel.hidden = !stage?.show_built_with_ai;
  const stats = stage?.built_stats?.length ? stage.built_stats : [{ label: 'Stats', value: 'Fill these in on the admin page' }];
  panel.innerHTML = `
    <div class="panel panel-ai">
      <p class="ai-kicker">Plot twist</p>
      <h2>This voting app was built with AI</h2>
      <dl class="ai-stats">${stats.map(s => `<div><dt>${esc(s.label)}</dt><dd>${esc(s.value)}</dd></div>`).join('')}</dl>
    </div>`;
}

// ---------------------------------------------------------------- actions

let toastTimer: number | undefined;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('is-on'), 2200);
}

async function setPoll(patch: Partial<Poll>) {
  if (!poll) return false;
  const error = await api.updatePoll(poll.id, patch);
  if (error) { toast(`Didn't save: ${error}`); return false; }
  Object.assign(poll, patch);
  render();
  return true;
}

async function setStage(patch: Partial<Stage>) {
  const error = await api.updateStage(patch);
  if (error) { toast(`Didn't save: ${error}`); return; }
  if (stage) Object.assign(stage, patch);
  render();
}

async function openVoting() {
  if (!poll) return;
  if (poll.status === 'revealed') return toast('Already revealed. Press X twice to reset first.');
  if (poll.status === 'open') return toast('Voting is already open');
  if (await setPoll({ status: 'open', closes_at: null })) toast('Voting is OPEN');
}

async function closeNow() {
  if (poll?.status !== 'open') return toast('Voting isn’t open');
  if (await setPoll({ status: 'closed', closes_at: null })) toast('Voting CLOSED');
}

/** C: start the countdown, or cancel it if it's already running. */
async function countdownKey() {
  if (!poll || poll.status !== 'open') return toast('Voting isn’t open');
  if (countdownActive()) {
    if (await setPoll({ closes_at: null })) toast('Countdown cancelled, voting stays open');
    return;
  }
  const error = await api.startCountdown(poll.id, COUNTDOWN_SECONDS);
  if (error) return toast(`Didn't start: ${error}`);
  await refresh();
  toast(`Voting closes in ${COUNTDOWN_SECONDS} seconds`);
}

async function reveal() {
  if (!poll || revealing) return;
  if (poll.status === 'revealed') return toast('Already revealed');
  if (poll.status === 'draft') return toast('Open voting first (O)');
  if (poll.status === 'open' && !(await setPoll({ status: 'closed' }))) return;

  await refresh(); // latest counts, including last-second votes
  const totals = options.map(o => ({ id: o.id, n: totalFor(o.id) }));
  const best = Math.max(...totals.map(t => t.n));
  if (best === 0) return toast('No votes to reveal yet');
  const tied = totals.filter(t => t.n === best).map(t => t.id);
  const winner = tied[Math.floor(Math.random() * tied.length)];

  revealing = true;
  render(); // drop blind mode: bars grow to their real sizes
  await sleep(2400); // let the bars grow before crowning anyone

  if (tied.length > 1) {
    toast(`It's a ${tied.length}-way tie! Breaking it at random…`);
    await sleep(900);
    await spin(tied, winner);
  }

  crown(winner);
  revealing = false;
  await setPoll({ status: 'revealed', blind_mode: false, winner_option_id: winner });
}

/** Light up the tied rows in turn, slowing down, and land on the winner. */
async function spin(ids: string[], winner: string) {
  const rows = ids.map(id => $('bars').querySelector<HTMLElement>(`.row[data-id="${id}"]`)!);
  const steps = 18 + ids.length * 2;
  // start where the last step (steps - 1) lands exactly on the winner
  const n = ids.length;
  const i = (((ids.indexOf(winner) - (steps - 1)) % n) + n) % n;
  for (let s = 0; s < steps; s++) {
    rows.forEach(r => r.classList.remove('is-spin'));
    rows[(i + s) % n].classList.add('is-spin');
    await sleep(70 + Math.pow(s / steps, 3) * 520);
  }
  rows.forEach(r => r.classList.remove('is-spin'));
}

function crown(winner: string) {
  $('bars').querySelectorAll<HTMLElement>('.row').forEach(r => {
    r.classList.toggle('is-winner', r.dataset.id === winner);
    r.classList.toggle('is-loser', r.dataset.id !== winner);
  });
  confetti();
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('confetti');
  const colors = ['#ffd23f', '#4dabf7', '#ff922b', '#e64980', '#51cf66', '#ffffff'];
  box.innerHTML = Array.from({ length: 140 }, () => {
    const style = [
      `left:${Math.random() * 100}%`,
      `background:${colors[Math.floor(Math.random() * colors.length)]}`,
      `animation-delay:${Math.random() * 0.6}s`,
      `animation-duration:${2.4 + Math.random() * 1.8}s`,
      `--drift:${(Math.random() - 0.5) * 30}cqw`,
      `--spin:${(Math.random() - 0.5) * 1440}deg`,
    ].join(';');
    return `<i style="${style}"></i>`;
  }).join('');
  setTimeout(() => { box.innerHTML = ''; }, 5000);
}

async function reset() {
  if (!poll) return;
  if (Date.now() > resetArmedUntil) {
    resetArmedUntil = Date.now() + 2500;
    return toast('Press X again to erase all votes for this poll');
  }
  resetArmedUntil = 0;
  const error = await api.resetVotes(poll.id);
  if (error) return toast(`Reset failed: ${error}`);
  await setPoll({ status: 'draft', winner_option_id: null, closes_at: null });
  $('bars').querySelectorAll('.row').forEach(r => r.classList.remove('is-winner', 'is-loser'));
  shown.clear();
  await refresh();
  toast('Reset: all votes erased, back to Waiting');
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => toast('Full screen not allowed here'));
}

function toggleCheats() {
  $('cheats').hidden = !$('cheats').hidden;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  const key = e.key.toLowerCase();
  const actions: Record<string, () => unknown> = {
    o: openVoting,
    c: () => (e.shiftKey ? closeNow() : countdownKey()),
    r: reveal,
    b: () => poll && setPoll({ blind_mode: !poll.blind_mode }).then(ok => ok && toast(`Blind mode ${poll!.blind_mode ? 'ON' : 'OFF'}`)),
    a: () => setStage({ show_built_with_ai: !stage?.show_built_with_ai }),
    q: toggleQa,
    n: nextQuestion,
    f: toggleFullscreen,
    x: reset,
    '?': toggleCheats,
    '/': toggleCheats, // Shift+/ reports as '/' on some keyboards
    h: toggleCheats,
    escape: () => {
      $('cheats').hidden = true;
      if (stage?.show_built_with_ai) void setStage({ show_built_with_ai: false });
    },
  };
  const action = actions[key];
  if (action) {
    e.preventDefault();
    void action();
  }
});
