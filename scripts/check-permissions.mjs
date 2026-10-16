// Usage: node scripts/check-permissions.mjs .env "$PWD"
// Needs the Supabase CLI linked to the project. Creates test data, then removes it.
// Run it before the talk, NOT during: it resets every poll to draft.
// Acts as a phone: only the public anon key, no sign-in.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const env = Object.fromEntries(readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
const URL = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const owner = sql => JSON.parse(execSync(`supabase db query --linked -o json ${JSON.stringify(sql)}`, { cwd: process.argv[3], stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/^[^\[{]*/s, ''));
const rest = async (method, path, body) => { const r = await fetch(`${URL}/rest/v1/${path}`, { method, headers: H, body: body && JSON.stringify(body) }); const t = await r.text(); return { status: r.status, body: t, short: t.slice(0, 90) }; };
const rpc = (fn, args) => rest('POST', `rpc/${fn}`, args);
const results = [];
const check = (name, ok, detail) => { results.push({ test: name, result: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 70) }); };

const rows = r => r.rows ?? r;
const cleanup = () => owner("delete from soh_questions where voter_id like 'test-phone-%'; delete from soh_votes where voter_id like 'test-phone-%'; delete from soh_polls where title='SOH TEST other poll'; update soh_polls set status='draft'; update soh_stage set show_built_with_ai=false where id=1");
cleanup();
const [poll] = rows(owner("select id from soh_polls where title = 'What should I build live?'"));
const opts = rows(owner(`select id from soh_options where poll_id = '${poll.id}' order by sort_order`));
const [other] = rows(owner("with p as (insert into soh_polls (title, status) values ('SOH TEST other poll','open') returning id) insert into soh_options (poll_id,label) select id,'x' from p returning id, poll_id"));
const A = 'test-phone-aaaaaaaaaaaa', B = 'test-phone-bbbbbbbbbbbb';

let r = await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: opts[0].id, p_voter_id: A });
check('Vote while poll is still draft', r.status >= 400, r.body);
owner(`update soh_polls set status='open' where id='${poll.id}'`);
r = await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: opts[0].id, p_voter_id: A });
check('Vote while open (should work)', r.status < 300, r.status);
r = await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: opts[2].id, p_voter_id: A });
const mine = rows(owner(`select count(*)::int n, max(option_id::text) o from soh_votes where voter_id='${A}'`))[0];
check('Change vote keeps one row per phone', r.status < 300 && mine.n === 1 && mine.o === opts[2].id, `rows=${mine.n}`);
r = await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: other.id, p_voter_id: B });
check('Vote for option from another poll', r.status >= 400, r.body);
r = await rest('GET', 'soh_votes?select=*');
check('Read other phones\' votes directly', r.body === '[]', r.body);
r = await rest('POST', 'soh_votes', { poll_id: poll.id, voter_id: B + 'x', option_id: opts[1].id });
check('Insert vote directly, bypassing function', r.status >= 400, r.body);
r = await rest('PATCH', `soh_polls?id=eq.${poll.id}`, { status: 'closed' });
check('Change poll status', r.status >= 400 || r.body === '[]', r.body);
r = await rest('PATCH', `soh_stage?id=eq.1`, { show_built_with_ai: true });
check('Change projector stage', r.status >= 400 || r.body === '[]', r.body);
r = await rest('DELETE', `soh_options?poll_id=eq.${poll.id}`);
check('Delete ballot options', r.status >= 400 || r.body === '[]', r.body);
r = await rpc('soh_results', { p_poll_id: poll.id });
check('Read live counts (owner only)', r.status >= 400, r.body);
r = await rest('GET', 'soh_admins?select=*');
check('Read admin list', r.body === '[]' || r.status >= 400, r.body);
owner(`update soh_polls set status='closed' where id='${poll.id}'`);
r = await rpc('soh_cast_vote', { p_poll_id: poll.id, p_option_id: opts[1].id, p_voter_id: B });
check('Vote after poll is closed', r.status >= 400, r.body);

r = await rpc('soh_ask', { p_body: 'Test question from phone A', p_voter_id: A });
const qid = JSON.parse(r.body);
check('Ask a question (should work)', r.status < 300, r.status);
await rpc('soh_ask', { p_body: 'Second question, unlimited', p_voter_id: A });
r = await rpc('soh_public_questions', { p_voter_id: B });
check('Other phones can\'t see unapproved questions', JSON.parse(r.body).every(q => q.status !== 'pending'), `${JSON.parse(r.body).filter(q => q.status === 'pending').length} pending visible`);
r = await rpc('soh_public_questions', { p_voter_id: A });
check('Asker sees own pending questions', JSON.parse(r.body).filter(q => q.mine && q.status === 'pending').length === 2, `${JSON.parse(r.body).filter(q => q.mine && q.status === 'pending').length} own pending`);
check('Public question list hides phone IDs', !r.body.includes('voter_id') && !r.body.includes(A), 'no voter_id field');
r = await rpc('soh_toggle_upvote', { p_question_id: qid, p_voter_id: B });
check('Upvote an unapproved question', r.status >= 400, r.body);
owner(`update soh_questions set status='approved' where id='${qid}'`);
await rpc('soh_toggle_upvote', { p_question_id: qid, p_voter_id: B });
await rpc('soh_toggle_upvote', { p_question_id: qid, p_voter_id: B });
r = await rpc('soh_toggle_upvote', { p_question_id: qid, p_voter_id: B });
const ups = JSON.parse((await rpc('soh_public_questions', { p_voter_id: B })).body)[0].upvotes;
check('Upvote toggles, max one per phone', ups === 1, `upvotes=${ups} after 3 taps`);
r = await rest('GET', 'soh_questions?select=*');
check('Read questions table directly', r.body === '[]', r.body);
r = await rpc('soh_ask', { p_body: 'x'.repeat(281), p_voter_id: A });
check('Question over 280 characters', r.status >= 400, r.body);

// ---- moderator link
const savedKey = rows(owner("select key_hash, created_at::text from soh_mod_key"))[0] ?? null; // keep any real link
const MOD = 'test-moderator-key-0123456789abcdef0123456789abcdef';
owner(`insert into soh_mod_key (id, key_hash) values (1, encode(sha256(convert_to('${MOD}','UTF8')),'hex')) on conflict (id) do update set key_hash = excluded.key_hash`);
const pendingQ = JSON.parse((await rpc('soh_ask', { p_body: 'Moderator test question', p_voter_id: A })).body);
r = await rpc('soh_mod_questions', { p_key: 'wrong-key-wrong-key-wrong-key-wrong-key' });
check('Moderator: wrong link is rejected', r.status >= 400, r.body);
r = await rpc('soh_mod_set_status', { p_key: '', p_question_id: pendingQ, p_status: 'approved' });
check('Moderator: no link can\'t approve', r.status >= 400, r.body);
r = await rpc('soh_new_mod_key', {});
check('Phone can\'t create a moderator link', r.status >= 400, r.body);
r = await rpc('soh_mod_questions', { p_key: MOD });
check('Moderator: valid link sees questions', r.status < 300 && JSON.parse(r.body).some(q => q.id === pendingQ), r.status);
check('Moderator list hides phone IDs', !r.body.includes('voter_id') && !r.body.includes(A), 'no voter_id field');
r = await rpc('soh_mod_set_onscreen', { p_key: MOD, p_question_id: pendingQ });
check('Moderator: unapproved can\'t go on screen', r.status >= 400, r.body);
r = await rpc('soh_mod_set_status', { p_key: MOD, p_question_id: pendingQ, p_status: 'approved' });
check('Moderator: approve (should work)', r.status < 300, r.status);
r = await rpc('soh_mod_set_onscreen', { p_key: MOD, p_question_id: pendingQ });
const onscreen = rows(owner('select onscreen_question_id::text id from soh_stage'))[0].id;
check('Moderator: put on screen (should work)', r.status < 300 && onscreen === pendingQ, r.status);
r = await rpc('soh_mod_set_status', { p_key: MOD, p_question_id: pendingQ, p_status: 'pending' });
check('Moderator: can\'t set made-up statuses', r.status >= 400, r.body);
r = await rest('PATCH', `soh_polls?id=eq.${poll.id}`, { status: 'open' });
check('Moderator key gives no poll access', r.status >= 400 || r.body === '[]', r.body);
owner('update soh_stage set onscreen_question_id = null');
owner(savedKey
  ? `update soh_mod_key set key_hash='${savedKey.key_hash}', created_at='${savedKey.created_at}'`
  : 'delete from soh_mod_key');

// clean up: remove all test data, back to a fresh draft poll
owner(`delete from soh_questions where voter_id like 'test-phone-%'; delete from soh_votes where voter_id like 'test-phone-%'; delete from soh_polls where title='SOH TEST other poll'; update soh_polls set status='draft' where id='${poll.id}'; update soh_stage set show_built_with_ai=false where id=1`);
const left = rows(owner("select (select count(*) from soh_votes)::int votes, (select count(*) from soh_questions)::int questions, (select count(*) from soh_polls)::int polls, (select count(*) from soh_options)::int options"))[0];
console.table(results);
console.log('after cleanup:', left);
