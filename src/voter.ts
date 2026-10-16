import './style.css';
import { phoneClient } from './lib/supabase';
import { getVoterId } from './lib/voterId';
import { serverClockOffset, watchTables } from './lib/live';
import { esc } from './lib/dom';
import type { Option, Poll, Stage } from './lib/types';

const db = phoneClient();
const voterId = getVoterId();
const view = document.getElementById('view')!;
const conn = document.getElementById('conn')!;

let poll: Poll | null = null;
let options: Option[] = [];
let myOptionId: string | null = null;
let myVoteLoadedFor: string | null = null;
let sending = false;
let flash: { kind: 'ok' | 'err'; text: string } | null = null;
let failures = 0;
let lastHtml = '';
let connTimer: number | undefined;
let clockOffset = 0; // add to Date.now() to get database time

async function refresh() {
  try {
    const { data: stage, error: stageErr } = await db.from('soh_stage').select('poll_id').eq('id', 1).maybeSingle<Pick<Stage, 'poll_id'>>();
    if (stageErr) throw stageErr;

    if (!stage?.poll_id) {
      poll = null;
      options = [];
    } else {
      const [p, o] = await Promise.all([
        db.from('soh_polls').select('id,title,status,blind_mode,winner_option_id,closes_at').eq('id', stage.poll_id).maybeSingle<Poll>(),
        db.from('soh_options').select('id,poll_id,label,description,sort_order').eq('poll_id', stage.poll_id).order('sort_order'),
      ]);
      if (p.error) throw p.error;
      if (o.error) throw o.error;
      poll = p.data;
      options = (o.data ?? []) as Option[];
    }

    // Restore this phone's earlier pick (e.g. after a reload), once per poll.
    if (poll && myVoteLoadedFor !== poll.id) {
      const { data, error } = await db.rpc('soh_my_vote', { p_poll_id: poll.id, p_voter_id: voterId });
      if (!error) {
        myOptionId = (data as string | null) ?? null;
        myVoteLoadedFor = poll.id;
      }
    }
    failures = 0;
  } catch (err) {
    failures++;
    console.warn(err);
  }
  render();
}

async function vote(optionId: string) {
  if (!poll || poll.status !== 'open' || secondsLeft() === 0 || sending) return;
  const previous = myOptionId;
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

void serverClockOffset(db).then(ms => { clockOffset = ms; render(); });

watchTables({
  client: db,
  tables: ['soh_stage', 'soh_polls', 'soh_options'],
  refresh,
  // Only show "Reconnecting" if realtime stays down for a few seconds.
  onStatus: s => {
    clearTimeout(connTimer);
    if (s === 'live') conn.hidden = true;
    else connTimer = window.setTimeout(() => { conn.hidden = false; }, 4000);
  },
});
