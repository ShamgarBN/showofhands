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
