import './style.css';
import { phoneClient } from './lib/supabase';
import { getVoterId } from './lib/voterId';
import { offsetFrom, pollEvery } from './lib/live';
import { esc } from './lib/dom';
import type { Option, Poll, PublicQuestion, Stage } from './lib/types';

const db = phoneClient();
const voterId = getVoterId();
const view = document.getElementById('view')!;
const conn = document.getElementById('conn')!;

let poll: Poll | null = null;
let options: Option[] = [];
let myOptionId: string | null = null;
let voteSeq = 0; // bumps on every tap, so a slow check can't undo a newer choice
let sending = false;
let flash: { kind: 'ok' | 'err'; text: string } | null = null;
let failures = 0;
let lastHtml = '';
let clockOffset = 0; // add to Date.now() to get database time

// Q&A
type Tab = 'vote' | 'ask';
let tab: Tab = 'vote';
let stageMode: Stage['mode'] | null = null;
let qaOpen = true;
let qaVersion: number | null = null;
let questions: PublicQuestion[] = [];
let questionsLoaded = false;
let lastQuestionsHtml = '';
const askPane = document.getElementById('ask')!;
const askForm = document.getElementById('ask-form') as HTMLFormElement;
const askText = document.getElementById('ask-text') as HTMLTextAreaElement;
const askSend = document.getElementById('ask-send') as HTMLButtonElement;
const askFlash = document.getElementById('ask-flash')!;
const qList = document.getElementById('q-list')!;

interface PhoneState {
  now: string;
  stage: Pick<Stage, 'poll_id' | 'mode' | 'qa_open' | 'qa_version'> | null;
  poll: Poll | null;
  options: Option[];
  my_vote: string | null;
}

/** One request returns everything this phone shows (see soh_phone_state). */
async function refresh() {
  const seq = voteSeq;
  const sent = Date.now();
  const { data, error } = await db.rpc('soh_phone_state', { p_voter_id: voterId });
  if (error || !data) {
    failures++;
    console.warn(error);
    render();
    return;
  }
  failures = 0;
  const state = data as PhoneState;
  clockOffset = offsetFrom(state.now, sent, Date.now());
  const stage = state.stage;

  // Follow the projector: when it switches between poll and Q&A, so does the phone.
  if (stage && stage.mode !== stageMode) {
    if (stageMode !== null || stage.mode === 'qa') setTab(stage.mode === 'qa' ? 'ask' : 'vote');
    stageMode = stage.mode;
  }
  qaOpen = stage?.qa_open ?? true;
  if (stage && stage.qa_version !== qaVersion) {
    qaVersion = stage.qa_version;
    if (tab === 'ask' || questionsLoaded) void loadQuestions();
  }

  poll = state.poll;
  options = state.options;
  // The server's record of this phone's vote wins (it also clears after a reset),
  // unless the person tapped again while this check was in flight.
  if (!sending && seq === voteSeq) myOptionId = state.my_vote;

  render();
  if (questionsLoaded) renderQuestions(); // picks up questions opening/closing
}

async function vote(optionId: string) {
  if (!poll || poll.status !== 'open' || secondsLeft() === 0 || sending) return;
  const previous = myOptionId;
  voteSeq++;
  myOptionId = optionId; // show the choice immediately
  sending = true;
  flash = null;
  render();

  const { error } = await db.rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: optionId, p_voter_id: voterId });
  sending = false;
  if (error) {
    myOptionId = previous;
    flash = /not open/.test(error.message)
      ? { kind: 'err', text: 'Voting just closed.' }
      : { kind: 'err', text: "That didn't go through. Tap again." };
    void refresh();
  } else {
    flash = { kind: 'ok', text: 'Vote recorded' };
  }
  render();
}

const serverNow = () => Date.now() + clockOffset;

/** Seconds left on the countdown, or null if there isn't one. */
function secondsLeft(): number | null {
  if (poll?.status !== 'open' || !poll.closes_at) return null;
  return Math.max(0, Math.ceil((Date.parse(poll.closes_at) - serverNow()) / 1000));
}

function deadlineText(left: number) {
  return `⏱ Voting closes in ${left}s`;
}

function optionLabel(id: string | null) {
  return options.find(o => o.id === id)?.label ?? '';
}

function render() {
  let html: string;

  if (failures > 0 && !poll) {
    html = state('Can’t reach the vote', 'Check your wifi or cellular. Retrying on its own…', 'spinner');
  } else if (!poll || poll.status === 'draft') {
    html = state('Voting opens soon', 'Keep this page open. It’ll switch on its own.', 'pulse');
  } else if (poll.status === 'open' && secondsLeft() !== 0) {
    const left = secondsLeft();
    html = `
      <section class="ballot">
        ${left !== null ? `<p class="deadline${left <= 10 ? ' is-urgent' : ''}" id="deadline">${deadlineText(left)}</p>` : ''}
        <h1 class="ballot-title">${esc(poll.title)}</h1>
        <p class="ballot-hint">Tap one. You can change it until voting closes.</p>
        <div class="choices" role="radiogroup" aria-label="${esc(poll.title)}">
          ${options.map(o => {
            const selected = o.id === myOptionId;
            return `
            <button class="choice${selected ? ' is-selected' : ''}" role="radio" aria-checked="${selected}" aria-label="${esc(o.label)}" data-id="${esc(o.id)}">
              <span class="choice-check" aria-hidden="true">${selected ? '✓' : ''}</span>
              <span class="choice-text">
                <span class="choice-label">${esc(o.label)}</span>
                ${o.description ? `<span class="choice-desc">${esc(o.description)}</span>` : ''}
              </span>
            </button>`;
          }).join('')}
        </div>
        <p class="flash ${flash ? `flash-${flash.kind}` : ''}" role="status">${flash ? (flash.kind === 'ok' ? '✓ ' : '') + esc(flash.text) : (sending ? 'Sending…' : '&nbsp;')}</p>
      </section>`;
  } else if (poll.status === 'closed' || poll.status === 'open') {
    html = state('Voting closed', 'Watch the screen!', 'eyes', myOptionId ? `You picked <strong>${esc(optionLabel(myOptionId))}</strong>` : '');
  } else {
    const winner = optionLabel(poll.winner_option_id);
    html = winner
      ? state('The room picked', esc(winner), 'trophy', myOptionId ? `You picked <strong>${esc(optionLabel(myOptionId))}</strong>` : '', true)
      : state('Voting closed', 'Watch the screen!', 'eyes');
  }

  if (html !== lastHtml) {
    view.innerHTML = html;
    lastHtml = html;
  }
}

function state(title: string, sub: string, icon: 'pulse' | 'spinner' | 'eyes' | 'trophy', extra = '', bigSub = false) {
  const art = {
    pulse: '<div class="pulse" aria-hidden="true"></div>',
    spinner: '<div class="spinner" aria-hidden="true"></div>',
    eyes: '<div class="state-emoji" aria-hidden="true">👀</div>',
    trophy: '<div class="state-emoji" aria-hidden="true">🏆</div>',
  }[icon];
  return `
    <section class="state">
      ${art}
      <h1 class="state-title">${title}</h1>
      <p class="${bigSub ? 'state-winner' : 'state-sub'}">${sub}</p>
      ${extra ? `<p class="state-extra">${extra}</p>` : ''}
    </section>`;
}

// ---------------------------------------------------------------- Q&A

function setTab(next: Tab) {
  tab = next;
  document.getElementById('tab-vote')!.setAttribute('aria-selected', String(next === 'vote'));
  document.getElementById('tab-ask')!.setAttribute('aria-selected', String(next === 'ask'));
  view.hidden = next !== 'vote';
  askPane.hidden = next !== 'ask';
  if (next === 'ask') void loadQuestions();
}

async function loadQuestions() {
  const { data, error } = await db.rpc('soh_public_questions', { p_voter_id: voterId });
  if (error) return console.warn(error);
  questions = (data ?? []) as PublicQuestion[];
  questionsLoaded = true;
  renderQuestions();
}

function renderQuestions() {
  askText.disabled = askSend.disabled = !qaOpen;
  askText.placeholder = qaOpen ? 'Type your question…' : 'Questions are closed right now';

  const pending = questions.filter(q => q.mine && q.status === 'pending');
  const approved = questions.filter(q => q.status === 'approved');
  const item = (q: PublicQuestion) => `
    <li class="q">
      <p class="q-body">${esc(q.body)}${q.mine ? ' <span class="q-mine">You asked</span>' : ''}</p>
      <button type="button" class="upvote${q.upvoted ? ' is-on' : ''}" data-q="${esc(q.id)}" aria-pressed="${q.upvoted}" aria-label="Upvote (${q.upvotes})">
        <span aria-hidden="true">▲</span> ${q.upvotes}
      </button>
    </li>`;

  const html = `
    ${pending.length ? `
      <h2 class="q-head">Waiting for approval</h2>
      <ul class="q-list q-pending">${pending.map(q => `<li class="q"><p class="q-body">${esc(q.body)}</p></li>`).join('')}</ul>` : ''}
    <h2 class="q-head">Questions from the room</h2>
    ${approved.length
      ? `<p class="q-hint">Tap ▲ on the ones you want answered.</p><ul class="q-list">${approved.map(item).join('')}</ul>`
      : '<p class="q-hint">None yet. Be the first!</p>'}`;
  if (html !== lastQuestionsHtml) {
    qList.innerHTML = html;
    lastQuestionsHtml = html;
  }
}

askForm.addEventListener('submit', async e => {
  e.preventDefault();
  const body = askText.value.trim();
  if (!body || askSend.disabled) return;
  askSend.disabled = true;
  askFlash.className = 'flash';
  askFlash.textContent = 'Sending…';
  const { error } = await db.rpc('soh_ask', { p_body: body, p_voter_id: voterId });
  askSend.disabled = !qaOpen;
  if (error) {
    askFlash.className = 'flash flash-err';
    askFlash.textContent = /closed/.test(error.message) ? 'Questions are closed right now.' : "That didn't send. Try again.";
    return;
  }
  askText.value = '';
  updateCount();
  askFlash.className = 'flash flash-ok';
  askFlash.textContent = '✓ Sent! It appears once the presenter approves it.';
  setTimeout(() => { if (askFlash.textContent?.startsWith('✓')) askFlash.innerHTML = '&nbsp;'; }, 5000);
  void loadQuestions();
});

// Return sends on phones; Shift+Return still adds a new line.
askText.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askSend.click(); } // requestSubmit needs iOS 16
});

function updateCount() {
  document.getElementById('ask-count')!.textContent = `${askText.value.length} / 280`;
}
askText.addEventListener('input', updateCount);

qList.addEventListener('click', async e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.upvote');
  const q = btn && questions.find(x => x.id === btn.dataset.q);
  if (!q) return;
  // show it immediately, then confirm with the server
  q.upvoted = !q.upvoted;
  q.upvotes += q.upvoted ? 1 : -1;
  renderQuestions();
  const { error } = await db.rpc('soh_toggle_upvote', { p_question_id: q.id, p_voter_id: voterId });
  if (error) console.warn(error);
  void loadQuestions();
});

document.getElementById('tab-vote')!.addEventListener('click', () => setTab('vote'));
document.getElementById('tab-ask')!.addEventListener('click', () => setTab('ask'));

// Upvote counts change without a stage event, so refresh the list while it's open.
setInterval(() => { if (tab === 'ask' && !document.hidden) void loadQuestions(); }, 8000);

view.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.choice');
  if (btn?.dataset.id) void vote(btn.dataset.id);
});

// Countdown: update the banner each tick; re-render when it crosses 10s or zero.
setInterval(() => {
  const left = secondsLeft();
  const el = document.getElementById('deadline');
  if (left === null || !el) return;
  if (left === 0 || (left <= 10) !== el.classList.contains('is-urgent')) render();
  else el.textContent = deadlineText(left);
}, 250);

// Check in every 2.5 seconds; show "Reconnecting…" after two failed checks in a row.
pollEvery(async () => {
  await refresh();
  conn.hidden = failures < 2;
}, 2500);
