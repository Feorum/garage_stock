import { createAuthController } from './src/auth.js';
import { element, icon, renderNotice } from './src/ui.js';
import { getSections, resolveSection } from './src/navigation.js';
import { renderSection } from './src/views.js';

const app = document.getElementById('app');
let controller;
let currentState;
let workspace;

function showLogin(message = '') {
  const email = element('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'username', required: true });
  const password = element('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const feedback = element('p', { class: 'form-feedback', role: 'status', 'aria-live': 'polite' }, message);
  const submit = element('button', { class: 'button button-primary', type: 'submit' }, 'Sign in');
  const form = element('form', { class: 'login-form', onsubmit: async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    feedback.textContent = '';
    const result = await controller.signIn(email.value.trim(), password.value);
    password.value = '';
    if (result?.error && form.isConnected) {
      feedback.textContent = result.error;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  } },
  element('label', { for: 'email' }, 'Email'), email,
  element('label', { for: 'password' }, 'Password'), password, submit, feedback);

  app.replaceChildren(element('main', { id: 'main-content', class: 'login-layout' },
    element('section', { class: 'login-intro' },
      element('span', { class: 'wordmark' }, 'Garage', element('span', { 'aria-hidden': 'true' }, '/')),
      element('p', { class: 'eyebrow' }, 'A clear place for every task'),
      element('h1', {}, 'Your workshop.\nOne workspace.'),
      element('p', { class: 'intro-copy' }, 'Owner assignments and manager orders, organized around the vehicle and the work to be done.'),
      element('div', { class: 'intro-note' }, icon('work'), element('span', {}, 'For the Owner and the workshop team.'))),
    element('section', { class: 'login-panel', 'aria-labelledby': 'signin-title' },
      element('span', { class: 'tag' }, 'Work orders'),
      element('h2', { id: 'signin-title' }, 'Welcome back'),
      element('p', { class: 'muted' }, 'Sign in with the account provided by the Owner.'),
      form,
      element('p', { class: 'login-help' }, 'Need access? Ask the Owner for an account or a fresh setup link.'))));
}

function showError(message) {
  workspace = null;
  app.replaceChildren(element('main', { id: 'main-content', class: 'startup' },
    element('span', { class: 'wordmark' }, 'Garage/'),
    renderNotice('We couldn’t open your workspace', message, 'error'),
    element('div', { class: 'button-row' },
      element('button', { class: 'button button-primary', onclick: () => controller ? controller.refresh() : location.reload() }, 'Try again'),
      controller ? element('button', { class: 'button', onclick: () => controller.signOut() }, 'Sign out') : null)));
}

function updateWorkspace(focus = false) {
  if (!workspace || currentState?.status !== 'ready') return;
  const { profile } = currentState;
  const section = resolveSection(profile.role, location.hash);
  for (const link of workspace.navigation.querySelectorAll('a')) {
    if (link.hash === `#${section.id}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  workspace.title.textContent = section.label;
  workspace.description.textContent = section.description;
  workspace.content.replaceChildren(renderSection(profile.role, section.id));
  document.title = `${section.label} · Garage`;
  if (focus) workspace.title.focus();
}

function showWorkspace(profile) {
  const owner = profile.role === 'admin';
  const sections = getSections(profile.role);
  const navigation = element('nav', { class: 'workspace-nav', 'aria-label': owner ? 'Owner workspace' : 'Mechanic workspace' },
    sections.map(section => element('a', { href: `#${section.id}`, class: 'nav-link' }, icon(section.icon), element('span', {}, section.label))));
  const title = element('h1', { tabindex: '-1' });
  const description = element('p', { class: 'page-description' });
  const content = element('div', { class: 'page-content' });
  const name = profile.name.trim() || (owner ? 'Owner' : 'Mechanic');
  const connection = element('span', { class: 'connection', role: 'status' });
  const updateConnection = () => {
    connection.textContent = navigator.onLine ? 'Online' : 'Offline';
    connection.classList.toggle('is-offline', !navigator.onLine);
  };
  updateConnection();

  app.replaceChildren(element('div', { class: 'workspace' },
    element('aside', { class: 'sidebar' },
      element('a', { class: 'wordmark', href: `#${sections[0].id}`, 'aria-label': 'Garage home' }, 'Garage', element('span', { 'aria-hidden': 'true' }, '/')),
      element('p', { class: 'sidebar-caption' }, owner ? 'Owner workspace' : 'Mechanic workspace'), navigation,
      element('div', { class: 'sidebar-foot' }, element('span', { class: 'version-label' }, 'Foundation · 01'), connection)),
    element('div', { class: 'workspace-body' },
      element('header', { class: 'workspace-header' },
        element('div', { class: 'identity' }, element('span', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 1).toLocaleUpperCase()),
          element('div', {}, element('span', { class: 'identity-name' }, name), element('span', { class: 'identity-role' }, owner ? 'Owner' : 'Mechanic'))),
        element('div', { class: 'header-actions' },
          element('a', { class: 'account-link', href: 'account.html' }, 'Account'),
          element('button', { class: 'button button-small', onclick: () => controller.signOut() }, 'Sign out'))),
      element('main', { id: 'main-content', class: 'workspace-main' },
        element('div', { class: 'page-heading' }, element('p', { class: 'eyebrow' }, 'Work orders'), title, description), content))));
  workspace = { navigation, title, description, content, updateConnection };
  updateWorkspace();
}

function showState(state) {
  currentState = state;
  workspace = null;
  if (state.status === 'signed_out') {
    document.title = 'Sign in · Garage';
    showLogin(state.message);
  } else if (state.status === 'ready') showWorkspace(state.profile);
  else if (state.status === 'error') showError(state.message);
  else {
    app.replaceChildren(element('main', { id: 'main-content', class: 'startup', 'aria-live': 'polite' },
      element('span', { class: 'wordmark' }, 'Garage/'), element('p', { class: 'muted' }, state.message || 'Opening your workspace…')));
  }
}

document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  const main = document.getElementById('main-content');
  main.setAttribute('tabindex', '-1');
  main.focus();
});
window.addEventListener('hashchange', () => updateWorkspace(true));
window.addEventListener('online', () => workspace?.updateConnection());
window.addEventListener('offline', () => workspace?.updateConnection());

async function start() {
  try {
    const { sb } = await import('./src/supabase.js');
    controller = createAuthController(sb, { onChange: showState });
    await controller.start();
  } catch {
    showError('Check your connection and try again. Sign-in needs an internet connection.');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
