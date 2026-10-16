# Show of Hands

Live audience voting and Q&A for a talk. The audience scans a QR code on the projector, votes from their phones, and asks questions. Results animate on the big screen. No accounts, no app installs, nothing collected about anyone.

Built live with Claude Code. See [BUILD_LOG.md](BUILD_LOG.md) for how that went.

| Who | Page | How they get there |
|---|---|---|
| Audience | https://shamgarbn.github.io/showofhands/ | QR code on the projector |
| You, on the projector | https://shamgarbn.github.io/showofhands/present.html | Magic-link sign-in |
| You, on your laptop | https://shamgarbn.github.io/showofhands/admin.html | Same sign-in |
| Moderator | `…/moderate.html#k=…` | A private link you make on the admin page |

## How it works

- **Frontend:** Vite with plain TypeScript, four pages, hosted on GitHub Pages. Every push to `main` deploys.
- **Backend:** Supabase (Postgres). The app lives in the Paperplate project, with every table and function prefixed `soh_` so it doesn't touch Paperplate's data.
- **Phones** never sign in. Each one gets a random ID saved in the browser, and can act only through a few database functions: vote, ask, upvote. Row Level Security blocks everything else.
- **Phones check in every 2.5 seconds** with one small request instead of holding a live connection. Supabase's free plan allows 100 live messages per second across all clients, and one change pushed to 150 phones would exceed that and disconnect everyone.
- **Projector, admin and moderator** use live updates (Supabase Realtime), fall back to checking every few seconds if the connection drops, and rebuild the connection on their own.
- **You** sign in with a magic link. Only the account listed in `soh_admins` can run the show.
- **The moderator** uses a private link instead of an account. Paperplate lets any signed-in account read and delete its tables, so a moderator account would get that access too. The database stores only a SHA-256 hash of the link's key.

## Keyboard shortcuts (projector)

| Key | Does |
|---|---|
| O | Open voting |
| C | Start the 30-second countdown; voting closes and the reveal runs at zero. Press again to cancel. |
| Shift+C | Close voting right now |
| R | Reveal the winner (closes voting first) |
| B | Blind mode on/off (hide counts until the reveal) |
| Q | Switch between the poll and Q&A |
| N | Q&A: mark the current question answered and show the next most-upvoted one |
| A | "Built with AI" panel on/off |
| F | Full screen |
| X X | Reset all votes (press twice) |
| ? or H | Cheat sheet |
| Esc | Close panels |

The button in the projector's footer always shows the next step (Open voting → Close in 30s → Reveal winner), so you can click instead.

## Run it on your Mac

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5174/showofhands/. You need a `.env` file (see [Setup](#setup-from-scratch)).

**Demo mode** runs the projector on fake votes with no sign-in, so you can rehearse anywhere, even offline. It only works on the local dev server and isn't included in the published site.

- http://localhost:5174/showofhands/present.html?demo
- http://localhost:5174/showofhands/present.html?demo=tie (forces a tie, to rehearse the tie-break)

## Deploy

Push to `main`. GitHub Actions builds the site and publishes it to Pages in about a minute. The build reads two **repository variables** (not secrets, since both values are public by design): `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Setup from scratch

You only need this to rebuild in a new Supabase project.

1. **Supabase project.** Link the CLI:
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   ```
2. **Database.** Run the migrations in order:
   ```bash
   for f in supabase/migrations/*.sql; do supabase db query --linked -f "$f"; done
   ```
3. **Make yourself the owner.** The sign-in form never creates accounts, so if your email isn't a user in the project yet, add it under Authentication → Users → Add user. Copy your user ID from that list, then run this in the SQL editor. It isn't in a migration, to keep your ID out of the public repo.
   ```sql
   insert into public.soh_admins (user_id) values ('YOUR-USER-ID');
   ```
4. **Auth settings** (Authentication → URL Configuration): add `https://shamgarbn.github.io/showofhands/**` and `http://localhost:5174/showofhands/**` to Redirect URLs. Anonymous sign-ins stay **off**; the app doesn't use them.
5. **`.env`** for local dev: copy `.env.example` and fill in the project URL and the **anon** key (Project Settings → API). Never put the `service_role` key anywhere in this project.
6. **GitHub:** add the same two values as repository variables, and set Pages → Source to "GitHub Actions".

## Testing scripts

Both use the Supabase CLI and change live data. **Run them the day before, never during the talk.** Each one cleans up after itself, but they open, close and reset the poll on stage.

```bash
node scripts/check-permissions.mjs .env "$PWD"
```

30 checks acting as a phone and as a moderator: voting twice, voting on a closed poll, reading other people's votes, changing the poll, seeing unapproved questions, using a bad moderator link, and more. All 30 should say PASS.

```bash
node scripts/load-test.mjs .env "$PWD" 150
```

Simulates 150 phones on one network (like venue wifi) voting, changing votes, and noticing when voting closes. Last results: 150/150 and 300/300 votes stored, zero errors.

## Day-of checklist

### The day before

- [ ] **Wake the database.** Open the [Supabase dashboard](https://supabase.com/dashboard/project/syoyddsbqsoptpcheuvy). If Paperplate shows as paused (free projects pause after about a week without activity), click **Restore** and wait for it to finish. It can take several minutes.
- [ ] **Sign in on the presenter laptop**, in the browser you'll present from. Request the magic link and open it **in that same browser**. You get about 2 sign-in emails per hour for the whole project, so don't request a second one while the first is on its way. The sign-in lasts, so you won't need email on the day.
- [ ] **Run both test scripts** (above). 30/30 PASS, and zero errors from the load test.
- [ ] **Fill in the "Built with AI" stats** on the admin page (time to build, prompts, and so on), and check them on the projector with **A**.
- [ ] **Rehearse the reveal** with rehearsal votes: admin page → Rehearsal → Start trickle, then press **C** and watch the countdown and reveal. Try `present.html?demo=tie` for the tie-break.
- [ ] **Set up the moderator** if you're using one: admin page → Moderator link → Create, then text them the link. Have them open it on their phone and confirm they see "Waiting for you."

### At the venue, before people arrive

- [ ] **Open the projector from the live site**, not localhost: https://shamgarbn.github.io/showofhands/present.html. The QR code points to whatever site the projector page came from, so a localhost projector would send phones to your laptop.
- [ ] **Two windows:** the projector page full screen (**F**) on the projector display, and the admin page on your laptop screen. Keys only reach the window in front; the admin page's buttons work from anywhere.
- [ ] **Keep the laptop awake:** plugged in, with sleep and screen saver off.
- [ ] **Test the QR from the back of the room** with your own phone, on **venue wifi**, then again on **cellular** (wifi off). Both should show "Voting opens soon."
- [ ] **Check the green dot** in the projector's footer. Green means live updates are connected. Yellow means it's using the fallback checks, which still works; it repairs itself within about 20 seconds.
- [ ] **Clear rehearsal votes:** admin page → **Wipe rehearsal votes**. The projector's red "rehearsal votes" badge should disappear.
- [ ] **Reset the poll:** status **Waiting**, 0 votes, blind mode set the way you want it.
- [ ] **Have the show-of-hands fallback ready:** if phones fail, count raised hands and enter them with the **+ / Set…** buttons on the admin page. They count toward the projector's totals.

### During the talk

1. Show the QR and press **O** (or the footer button) when you want voting open. Phones switch on their own within a few seconds.
2. When most people have voted, press **C**. Everyone sees a 30-second countdown, and the reveal runs at zero. **Shift+C** skips the countdown.
3. For Q&A, press **Q**. Phones switch to their Ask tab. You or the moderator approve questions; **N** moves to the next one.
4. Press **A** for the "Built with AI" reveal.

### After the talk

- [ ] **Turn off the moderator link** on the admin page.
- [ ] **Delete the questions** if you don't want to keep them (they hold only the question text, nothing about who asked).

## Limits worth knowing

- **One vote per phone, not per person.** Someone who clears their browser data or opens a private window gets a new ID and can vote again. That's an accepted trade-off for a room vote with no sign-in. The database enforces one vote per ID and rejects votes on closed polls.
- **Anyone with the moderator link can moderate.** Text it only to your moderator, and replace it if it leaks; replacing it cuts off the old link within seconds.
- **The public `anon` key is meant to be public.** It's in the published site and this repo on purpose. What it can do is limited by the database's Row Level Security rules and the `soh_` functions, which the permission checks test.
- **Free-plan pause.** The database pauses after about a week without activity, which is the first item on the checklist.
- **Phone timing.** Phones see changes within about 2.5 seconds; the projector and admin page update within about a second.
