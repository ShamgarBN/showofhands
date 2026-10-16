// Simulates a room of phones on ONE network (like venue wifi): each checks in every
// 2.5 s, votes once voting opens, some change their minds, then voting closes.
// Measures errors, response times, and how fast phones notice the poll closing.
//
// Usage: node scripts/load-test.mjs .env "$PWD" [phones=150]
// Needs the Supabase CLI linked to the project. Run it BEFORE the talk, never during:
// it opens and closes the poll on stage, and deletes its own votes afterward.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const env = Object.fromEntries(readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
const cwd = process.argv[3];
const PHONES = Number(process.argv[4] ?? 150);
const URL = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const owner = sql => execSync(`supabase db query --linked ${JSON.stringify(sql)}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);

const stats = { state: [], vote: [], errors: {}, closeSeenAfter: [] };
const fail = key => { stats.errors[key] = (stats.errors[key] ?? 0) + 1; };

async function rpc(fn, body, bucket) {
  const start = Date.now();
  try {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    stats[bucket].push(Date.now() - start);
    if (!r.ok) { fail(`${fn} HTTP ${r.status}: ${(JSON.parse(text || '{}').message ?? '').slice(0, 40)}`); return { ok: false }; }
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (e) {
    fail(`${fn} ${e.name}`);
    return { ok: false };
  }
}

let closedAt = null;
let stop = false;

async function phone(i) {
  const id = `loadtest-${crypto.randomUUID()}`;
  await sleep(Math.random() * 5000); // people scan the QR at different moments
  let voted = false, changed = false, sawClose = false;
  while (!stop) {
    const state = (await rpc('soh_phone_state', { p_voter_id: id }, 'state')).data;
    const poll = state?.poll;
    if (poll?.status === 'open' && !voted) {
      await sleep(Math.random() * 8000); // reading the options
      const opt = state.options[Math.floor(Math.random() * state.options.length)];
      voted = (await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: opt.id, p_voter_id: id }, 'vote')).ok; // failed? tap again next loop
    } else if (poll?.status === 'open' && voted && !changed && Math.random() < 0.1) {
      const opt = state.options[Math.floor(Math.random() * state.options.length)];
      await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: opt.id, p_voter_id: id }, 'vote');
      changed = true;
    }
    if (poll?.status === 'closed' && closedAt && !sawClose) {
      sawClose = true;
      stats.closeSeenAfter.push(Date.now() - closedAt);
    }
    await sleep(2500);
  }
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const line = (name, arr) => console.log(`${name.padEnd(22)} n=${String(arr.length).padStart(5)}  p50=${pct(arr, .5)}ms  p95=${pct(arr, .95)}ms  max=${Math.max(0, ...arr)}ms`);

console.log(`${at()}s  ${PHONES} phones joining…`);
owner("update soh_polls set status='draft', closes_at=null, winner_option_id=null where id = (select poll_id from soh_stage); delete from soh_votes where voter_id like 'loadtest-%'");
const phones = Array.from({ length: PHONES }, (_, i) => phone(i));

await sleep(8000);
console.log(`${at()}s  opening voting`);
owner("update soh_polls set status='open' where id = (select poll_id from soh_stage)");

await sleep(25000);
console.log(`${at()}s  closing voting`);
owner("update soh_polls set status='closed' where id = (select poll_id from soh_stage)");
closedAt = Date.now();

await sleep(8000);
stop = true;
await Promise.all(phones);

const counted = execSync(`supabase db query --linked -o json "select count(*)::int n from soh_votes where voter_id like 'loadtest-%'"`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const n = (JSON.parse(counted.slice(counted.search(/[\[{]/))).rows ?? JSON.parse(counted.slice(counted.search(/[\[{]/))))[0].n;

console.log('\n--- results');
line('phone check-ins', stats.state);
line('votes', stats.vote);
line('noticed close after', stats.closeSeenAfter);
console.log(`phones that noticed close: ${stats.closeSeenAfter.length}/${PHONES}`);
console.log(`votes stored: ${n}/${PHONES} (one per phone)`);
console.log(`errors: ${Object.keys(stats.errors).length ? JSON.stringify(stats.errors) : 'none'}`);
console.log(`request rate: ~${Math.round((stats.state.length + stats.vote.length) / ((Date.now() - t0) / 1000))}/s from one IP`);

owner("delete from soh_votes where voter_id like 'loadtest-%'; update soh_polls set status='draft', closes_at=null, winner_option_id=null where id = (select poll_id from soh_stage)");
console.log('cleaned up: load-test votes deleted, poll back to draft');
