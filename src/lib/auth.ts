import type { SupabaseClient } from '@supabase/supabase-js';
import { esc } from './dom';

/**
 * Shows a magic-link sign-in card until the owner is signed in.
 * Resolves once a signed-in user who is listed in soh_admins is present.
 */
export async function requireOwner(db: SupabaseClient, mount: HTMLElement): Promise<void> {
  // supabase-js finishes the magic-link sign-in from the ?code= in the URL on load.
  const { data } = await db.auth.getSession();
  if (location.search.includes('code=')) history.replaceState(null, '', location.pathname + location.hash);

  if (data.session) {
    if (await isOwner(db)) return;
    showNotOwner(db, mount, data.session.user.email ?? '');
    return new Promise(() => {}); // stays on the "not authorized" screen
  }

  return new Promise(resolve => {
    showSignIn(db, mount);
    const { data: sub } = db.auth.onAuthStateChange(async (_event, session) => {
      if (!session) return;
      if (await isOwner(db)) {
        sub.subscription.unsubscribe();
        resolve();
      } else {
        showNotOwner(db, mount, session.user.email ?? '');
      }
    });
  });
}

async function isOwner(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc('soh_is_owner');
  return !error && data === true;
}

function showSignIn(db: SupabaseClient, mount: HTMLElement) {
  mount.innerHTML = `
    <form class="signin" novalidate>
      <h1>Presenter sign-in</h1>
      <p class="signin-sub">We'll email you a sign-in link. Open it <strong>in this browser, on this computer</strong>.</p>
      <label for="signin-email">Email</label>
      <input id="signin-email" type="email" autocomplete="email" required />
      <button type="submit">Send sign-in link</button>
      <p class="signin-msg" role="status"></p>
    </form>`;
  const form = mount.querySelector('form')!;
  const msg = mount.querySelector<HTMLElement>('.signin-msg')!;
  const button = form.querySelector('button')!;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = (form.querySelector('input') as HTMLInputElement).value.trim();
    if (!email) return;
    button.disabled = true;
    msg.textContent = 'Sending…';
    const { error } = await db.auth.signInWithOtp({
      email,
      // Only existing accounts can sign in here; this page never creates users.
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    button.disabled = false;
    if (!error) {
      msg.innerHTML = 'Check your email and click the link. <br>This page signs in on its own if you open the link in this browser.';
    } else if (/rate limit/i.test(error.message)) {
      msg.textContent = 'Email limit reached (Supabase sends only a couple per hour). Use the link already in your inbox, or wait and try again.';
    } else {
      msg.textContent = `Couldn't send the link: ${error.message}`;
    }
  });
}

function showNotOwner(db: SupabaseClient, mount: HTMLElement, email: string) {
  mount.innerHTML = `
    <div class="signin">
      <h1>Not authorized</h1>
      <p class="signin-sub">${esc(email)} is signed in but isn't the presenter for this app.</p>
      <button type="button">Sign out</button>
    </div>`;
  mount.querySelector('button')!.addEventListener('click', async () => {
    await db.auth.signOut();
    location.reload();
  });
}
