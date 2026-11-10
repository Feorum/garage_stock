import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// Public project settings are substituted when the site is served or built.
const SUPABASE_URL = "https://cjcevfdhzaemxqhhxtrt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_iCy4oYTjilzbUYXtI3M-rA_Pf-bHCGh";

const callback = new URL(location.href);
const fragment = new URLSearchParams(callback.hash.slice(1));
const callbackError = fragment.has('error') || fragment.has('error_description') ||
  callback.searchParams.has('error') || callback.searchParams.has('error_description');
const unsupportedCallback = callback.searchParams.has('code') || callback.searchParams.has('token_hash');
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true }
});

const form = document.getElementById('password-form');
const password = document.getElementById('password');
const confirmation = document.getElementById('confirm-password');
const save = document.getElementById('save-password');
const message = document.getElementById('message');
const intro = document.getElementById('intro');
const openApp = document.getElementById('open-app');

const scrubCallback = () => history.replaceState(null, '', location.pathname);
const tell = (text, error = false) => {
  message.textContent = text;
  message.className = error ? 'error' : '';
};
const invalidLink = () => {
  form.hidden = true;
  intro.textContent = 'This account link is missing, expired, or invalid.';
  tell('Setup links work only once. If you already chose a password, open the garage log to sign in. Otherwise, ask your administrator for a new setup email.', true);
  openApp.hidden = false;
};

async function initialize() {
  try {
    // Await the SDK's implicit callback processing before removing its URL data.
    const { data, error } = await sb.auth.getSession();
    scrubCallback();
    if (callbackError || unsupportedCallback || error || !data.session) return invalidLink();
    // Verify the session with the server before allowing a password change.
    const { data: verified, error: verificationError } = await sb.auth.getUser();
    if (verificationError || !verified.user) return invalidLink();
    intro.textContent = 'Choose a password with at least 12 characters.';
    form.hidden = false;
  } catch {
    invalidLink();
  } finally {
    scrubCallback();
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (save.disabled) return;
  if (password.value.length < 12) return tell('Use at least 12 characters.', true);
  if (password.value !== confirmation.value) return tell('The passwords do not match.', true);
  save.disabled = true;
  tell('Saving your password…');
  try {
    const { error } = await sb.auth.updateUser({ password: password.value });
    if (error) {
      tell('Your password could not be saved. Try again, or ask for a fresh setup email.', true);
      return;
    }
    document.getElementById('title').textContent = 'Password saved';
    intro.textContent = 'Your account is ready. You can open the garage log now.';
    tell('Use your email address and new password when you sign in again.');
    form.hidden = true;
    openApp.hidden = false;
  } catch {
    tell('Could not reach the account service. Check your connection and try again.', true);
  } finally {
    password.value = '';
    confirmation.value = '';
    save.disabled = false;
  }
});

initialize();
