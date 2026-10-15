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
