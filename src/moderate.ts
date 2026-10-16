import './style.css';
import { phoneClient } from './lib/supabase';
import { watchTables } from './lib/live';
import { esc } from './lib/dom';
import type { Question, QuestionStatus, Stage } from './lib/types';

interface ModQuestion extends Question { on_screen: boolean }

// The key lives in the #fragment, which browsers never send to any server.
const key = new URLSearchParams(location.hash.slice(1)).get('k') ?? '';
const db = phoneClient();
const view = document.getElementById('view')!;
const conn = document.getElementById('conn')!;

let questions: ModQuestion[] = [];
let stage: Pick<Stage, 'mode' | 'qa_open'> | null = null;
let failures = 0;
let lastHtml = '';
let busy = false;

const { data: valid } = await db.rpc('soh_mod_check', { p_key: key });
if (valid !== true) {
  view.innerHTML = `
    <section class="state">
      <div class="state-emoji" aria-hidden="true">🔒</div>
      <h1 class="state-title">Link not valid</h1>
      <p class="state-sub">This moderator link was replaced or turned off. Ask the presenter for a new one.</p>
    </section>`;
} else {
  start();
}

function start() {
  view.addEventListener('click', onClick);
  watchTables({
    client: db,
    tables: ['soh_stage'],
    refresh,
    // New questions don't send live events to this page, so check often.
    fallbackMs: 3000,
    safetyMs: 3000,
    onStatus: s => { conn.hidden = s === 'live'; },
  });
}

async function refresh() {
  if (busy) return;
  const [q, st] = await Promise.all([
    db.rpc('soh_mod_questions', { p_key: key }),
    db.from('soh_stage').select('mode,qa_open').eq('id', 1).maybeSingle<Pick<Stage, 'mode' | 'qa_open'>>(),
  ]);
  if (q.error && /invalid moderator link/.test(q.error.message)) {
    location.reload(); // link was revoked: show the "not valid" screen
    return;
  }
  if (q.error || st.error) {
    failures++;
  } else {
    failures = 0;
    questions = (q.data ?? []) as ModQuestion[];
    stage = st.data;
  }
  render();
}

function render() {
  const pending = questions.filter(q => q.status === 'pending');
  const approved = questions.filter(q => q.status === 'approved').sort((a, b) => b.upvotes - a.upvotes);
  const done = questions.filter(q => q.status === 'answered' || q.status === 'hidden');
  const onScreen = approved.find(q => q.on_screen);
  document.title = pending.length ? `(${pending.length}) Moderator` : 'Show of Hands · Moderator';

  const card = (q: ModQuestion, buttons: string) => `
    <li class="mq${q.on_screen ? ' is-onscreen' : ''}">
      <p class="mq-body">${esc(q.body)}</p>
      <div class="mq-meta"><span>▲ ${q.upvotes}</span><span>${timeAgo(q.created_at)}</span>${q.on_screen ? '<span class="on-stage">ON SCREEN</span>' : ''}</div>
      <div class="mq-actions">${buttons}</div>
    </li>`;
  const b = (act: string, id: string, label: string, cls = 'btn-ghost') =>
    `<button type="button" class="btn ${cls}" data-act="${act}" data-id="${id}">${label}</button>`;

  const html = `
    ${failures > 1 ? '<p class="mod-banner mod-banner-err">Having trouble reaching the server. Retrying…</p>' : ''}
    <p class="mod-banner">
      Projector shows <strong>${stage?.mode === 'qa' ? 'Q&amp;A' : 'the poll'}</strong>.
      ${stage?.mode === 'qa' ? '' : 'Your on-screen pick appears when the presenter switches to Q&amp;A.'}
      ${stage?.qa_open === false ? '<br>Phones can’t send questions right now.' : ''}
    </p>

    <h2 class="q-head">Waiting for you ${pending.length ? `<span class="pending-badge">${pending.length}</span>` : ''}</h2>
    <ul class="mq-list">${pending.map(q => card(q, b('approved', q.id, 'Approve', '') + b('hidden', q.id, 'Hide', 'btn-danger'))).join('') || '<li class="q-hint">Nothing waiting. New questions show up here on their own.</li>'}</ul>

    ${onScreen ? `
      <h2 class="q-head">On screen now</h2>
      <ul class="mq-list">${card(onScreen, b('offscreen', onScreen.id, 'Take off screen') + b('answered', onScreen.id, 'Answered'))}</ul>` : ''}

    <h2 class="q-head">Approved (most upvoted first)</h2>
    <ul class="mq-list">${approved.filter(q => !q.on_screen).map(q => card(q,
      b('onscreen', q.id, 'Put on screen', '') + b('answered', q.id, 'Answered') + b('hidden', q.id, 'Hide', 'btn-danger'))).join('') || '<li class="q-hint">None yet.</li>'}</ul>

    ${done.length ? `
      <details class="mod-done">
        <summary>Answered and hidden (${done.length})</summary>
        <ul class="mq-list">${done.map(q => card(q, `<span class="q-hint">${q.status}</span>` + b('approved', q.id, 'Restore'))).join('')}</ul>
      </details>` : ''}`;

  if (html !== lastHtml) {
    const open = view.querySelector('details')?.open; // keep the "done" list open across refreshes
    view.innerHTML = html;
    if (open) view.querySelector('details')?.setAttribute('open', '');
    lastHtml = html;
  }
}

async function onClick(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!btn || busy) return;
  const id = btn.dataset.id!;
  const act = btn.dataset.act!;
  busy = true;
  btn.disabled = true;
  const { error } = act === 'onscreen' || act === 'offscreen'
    ? await db.rpc('soh_mod_set_onscreen', { p_key: key, p_question_id: act === 'onscreen' ? id : null })
    : await db.rpc('soh_mod_set_status', { p_key: key, p_question_id: id, p_status: act as QuestionStatus });
  busy = false;
  if (error) {
    btn.disabled = false;
    alert(`That didn't save: ${error.message}`);
  }
  await refresh();
}

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`;
}
