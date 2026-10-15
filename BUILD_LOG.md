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
