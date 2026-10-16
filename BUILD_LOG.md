# Build log

How this app was built with Claude Code, for the "I built this with AI" part of the talk.

| | |
|---|---|
| Started | 2026-10-15, 19:21 EDT (after the planning interview) |
| Finished | _in progress_ |
| Prompts so far | 9 (brief, 7 interview answers, plan approval) |

## Planning interview

- Claude interviewed me before writing any code: hosting, look, login, Q&A, security.
- Claude checked Supabase's current docs and found two gotchas:
  - Anonymous sign-ins are capped at **30 per hour per IP address**, and a whole room on venue wifi shares one IP. Fixed with a dashboard setting.
  - The built-in email sender allows only **2 emails per hour** for the whole project, which matters for magic-link login.
- I chose to drop most of the original security extras for a one-time room vote.

## Stage 1: scaffold and deploy

- Vite + TypeScript, three pages (phone, projector, admin), GitHub Actions deploy to GitHub Pages.
- Problem: the TypeScript check tried to type-check the Node-only Vite config. Fix: excluded it from the browser type check.

## Stage 2: database

- Reused an existing Supabase project (Paperplate) instead of making a new one, so I'd stay on the free plan.
- **Notable catch:** before changing anything, Claude inspected the project and found that every Paperplate table lets *any signed-in user* read and delete everything. The original plan, anonymous sign-ins for phones, would have let anyone in the audience wipe my recipe app.
- **Fix:** no anonymous sign-ins. Each phone gets a random browser ID and can only act through five small database functions. Paperplate's existing rules weren't touched.
- Dry-ran the migration inside a transaction that rolled back, then applied it for real.
- Ran 20 permission tests as an audience phone: vote twice, vote on a closed poll, vote for another poll's option, read others' votes, change the poll, see unapproved questions. All blocked; the allowed actions worked.

## Stage 3: phone voting screen

- Big tap targets with a name and one-line description, a clear selected state, and "Vote recorded" feedback.
- Switches on its own: "Voting opens soon" → ballot → "Voting closed, watch the screen" → "The room picked…", each within about a second via Supabase Realtime, with a check every 4 seconds if the live connection drops.
- Remembers your choice after a reload; changing your vote updates the same row instead of adding one.
- About 61 KB compressed, so it loads fast on cellular.
- Problem: the option buttons had no names for screen readers. Fix: added labels.

## Stage 4: projector view

- 16:9 stage that scales as one frame, so 1080p and 4K look identical. Huge QR code generated in the browser (no outside service), the short URL, live animated bars, total votes and a status chip.
- Keyboard controls for everything: O open, C close, R reveal, B blind mode, A "Built with AI" panel, F full screen, X X reset, ? or H cheat sheet.
- Reveal: bars grow to their real sizes, a pause, then the winner gets a gold glow, a trophy and confetti. A tie triggers a slowing "spin" between the tied options that lands on a random winner.
- Magic-link sign-in for the presenter; only my account is allowed in.
- **Real-world snag:** I opened the sign-in link in the wrong browser, then hit Supabase's 2-emails-per-hour limit. Instead of waiting, Claude added a dev-only demo mode with fake votes, so the projector could be tested without signing in. It's stripped from the published site.
- Problems found while testing: option names wrapped and pushed the last row off-screen at 1080p (fixed by restacking each row); the cheat sheet needed a second key (H) because some keyboards report Shift+/ differently.

## Change request: 30-second countdown

- My idea mid-build: voting stays open with no timer; I press a button and a 30-second countdown starts, then it closes and reveals automatically.
- Claude built it end to end: a big countdown on the projector (red for the last 10 seconds), "Voting closes in 23s" on every phone, and an always-visible button on the projector that follows the flow: Open voting → Close in 30s → Cancel countdown → Reveal winner.
- The **database** enforces the deadline, not just the screen: a vote one second late is rejected. Phones and projector sync to the database clock so they count down together.
- C starts the countdown (C again cancels); Shift+C still closes immediately.
- Bug caught in testing: the button stayed visible after the reveal because a style overrode "hidden". Fixed with one global rule.

## Stage 5: admin page

- Live controls: open, close in 30s (+ auto-reveal), cancel, close now, blind mode, reset (with a confirm), and **"Reveal on projector"**, which signals the projector window to run its animation. Claude flagged that on the day my laptop will show the admin page while the projector shows the presenter view, so keyboard shortcuts in one window wouldn't reach the other.
- Results table split into phones / rehearsal / by hand.
- Show-of-hands fallback: +/− buttons and "Set…" per option to type in a hand count.
- Rehearsal mode: N fake voters trickle in over T seconds with uneven odds, flagged as rehearsal, red badge on the projector, one-click wipe.
- Poll editor: create, rename, add/remove/reorder options. Editing keeps existing options' votes; removing one asks first.
- "Built with AI" stats editor and an on/off switch for the projector panel.

## Stage 6: audience Q&A (stretch goal)

- Phones get **Vote** and **Ask a question** tabs, and switch automatically to whichever one the projector is showing.
- Unlimited questions per phone, 280 characters max, no names. Each phone sees approved questions plus its own pending ones, and can upvote once per question.
- Nothing reaches the projector or other phones until I approve it on the admin page (Approve / Hide / Put on screen / Answered / Restore).
- Projector Q&A mode (key Q): a "Now answering" card plus the top questions by upvotes. N marks the current one answered and puts the next most-upvoted on screen.
- Design wrinkle: phones aren't allowed to read the questions table (so they never see others' phone IDs or unapproved questions), which also means they get no live events from it. Fix: a database trigger bumps a counter on the stage whenever a question is moderated; phones see that and refetch.
- Re-ran the 20 permission checks after all the changes. Two "failed" on the first run, but because of my leftover test question, not a security gap; tightened the test to check only what matters, and all 20 pass.

## Change request: a moderator role

- My idea: a third person (moderator) approves Q&A questions from their phone while I present.
- Claude pushed back on giving the moderator a normal account: in this shared Supabase project, any signed-in account can read and delete my other app's data. Instead: a **private moderator link** I text to them. No account, no email.
- The database stores only a scrambled (SHA-256) version of the link's key. "Replace link" kills the old one instantly; "Turn off link" locks the moderator out within seconds (tested).
- The moderator can approve, hide, mark answered, and choose which approved question is on the projector. Nothing else: no poll controls, no phone IDs.
- Permission checks grew from 20 to 30, all passing, including: wrong link rejected, a phone can't create a link, unapproved questions can't go on screen, the link gives no poll access.

## Stage 7: reliability pass

- **Biggest catch of the build:** checking Supabase's current docs turned up a free-plan limit of **100 Realtime messages per second**, counted per phone. One "voting is open" change pushed to 150 phones is 150 messages at once, and going over disconnects everyone, right at the key moment. Fix: phones no longer hold live connections. Each one checks in every 2.5 seconds with **one small request** that returns everything it needs. Only the projector, admin and moderator screens (3 connections) stay live.
- **Load test** from a single IP address (like a room on venue wifi):
  - 150 phones: 150/150 votes stored, zero errors, votes answered in ~40 ms, every phone noticed "voting closed" within one check-in.
  - 300 phones (2× the expected crowd): 300/300 votes, zero errors on the final run, ~90 requests/second.
- **Self-repair:** cut the live connection on purpose; the screen kept updating through regular checks (a new question arrived in 3 s), showed "Reconnecting…", and rebuilt its live connection on its own about 20 seconds later.
- Every request now gives up after 8 seconds, so a stalled venue network can't freeze a screen.
- Older phones: works back to iOS 15 Safari (fallbacks for three newer browser features).
- Bug found along the way: after a reset, a phone kept showing the vote it had cast before. Now the phone always follows the server's record.
