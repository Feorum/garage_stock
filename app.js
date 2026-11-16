import { createAuthController } from './src/auth.js';
import { element, icon, renderNotice } from './src/ui.js';
import { getSections, resolveSection } from './src/navigation.js';
import { createSectionView } from './src/views.js';
import { installRussianValidation } from './src/locale.js';

installRussianValidation();

const app = document.getElementById('app');
let controller;
let client;
let currentState;
let workspace;
let activeView;

function disposeView() {
  activeView?.dispose();
  activeView = null;
}

function showLogin(message = '') {
  const email = element('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'username', required: true });
  const password = element('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const feedback = element('p', { class: 'form-feedback', role: 'status', 'aria-live': 'polite' }, message);
  const submit = element('button', { class: 'button button-primary', type: 'submit' }, 'Войти');
  const form = element('form', { class: 'login-form', onsubmit: async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = 'Выполняется вход…';
    feedback.textContent = '';
    const result = await controller.signIn(email.value.trim(), password.value);
    password.value = '';
    if (result?.error && form.isConnected) {
      feedback.textContent = result.error;
      submit.disabled = false;
      submit.textContent = 'Войти';
    }
  } },
  element('label', { for: 'email' }, 'Электронная почта'), email,
  element('label', { for: 'password' }, 'Пароль'), password, submit, feedback);

  app.replaceChildren(element('main', { id: 'main-content', class: 'login-layout' },
    element('section', { class: 'login-intro' },
      element('span', { class: 'wordmark' }, 'Garage', element('span', { 'aria-hidden': 'true' }, '/')),
      element('p', { class: 'eyebrow' }, 'Каждая задача на своём месте'),
      element('h1', {}, 'Ваша мастерская.\nВсё в одном месте.'),
      element('p', { class: 'intro-copy' }, 'Поручения владельца и заказы менеджеров: автомобили, задачи и ход выполнения.'),
      element('div', { class: 'intro-note' }, icon('work'), element('span', {}, 'Для владельца и команды мастерской.'))),
    element('section', { class: 'login-panel', 'aria-labelledby': 'signin-title' },
      element('span', { class: 'tag' }, 'Заказы и работы'),
      element('h2', { id: 'signin-title' }, 'Добро пожаловать'),
      element('p', { class: 'muted' }, 'Войдите в учётную запись, которую предоставил владелец.'),
      form,
      element('p', { class: 'login-help' }, 'Нужен доступ? Попросите владельца создать учётную запись или прислать новую ссылку.'))));
}

function showError(message) {
  disposeView();
  workspace = null;
  app.replaceChildren(element('main', { id: 'main-content', class: 'startup' },
    element('span', { class: 'wordmark' }, 'Garage/'),
    renderNotice('Не удалось открыть рабочее пространство', message, 'error'),
    element('div', { class: 'button-row' },
      element('button', { class: 'button button-primary', onclick: () => controller ? controller.refresh() : location.reload() }, 'Повторить'),
      controller ? element('button', { class: 'button', onclick: () => controller.signOut() }, 'Выйти') : null)));
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
  disposeView();
  activeView = createSectionView(profile.role, section.id, profile, client);
  workspace.content.replaceChildren(activeView.element);
  document.title = `${section.label} · Garage`;
  if (focus) workspace.title.focus();
}

function showWorkspace(profile) {
  const owner = profile.role === 'admin';
  const sections = getSections(profile.role);
  const navigation = element('nav', { class: 'workspace-nav', 'data-workspace-role': profile.role, 'aria-label': owner ? 'Кабинет владельца' : 'Кабинет механика' },
    sections.map(section => element('a', { href: `#${section.id}`, class: 'nav-link' }, icon(section.icon), element('span', {}, section.label))));
  const title = element('h1', { tabindex: '-1' });
  const description = element('p', { class: 'page-description' });
  const content = element('div', { class: 'page-content' });
  const name = profile.name.trim() || (owner ? 'Владелец' : 'Механик');
  const connection = element('span', { class: 'connection', role: 'status' });
  const updateConnection = () => {
    connection.textContent = navigator.onLine ? 'В сети' : 'Нет сети';
    connection.classList.toggle('is-offline', !navigator.onLine);
  };
  updateConnection();

  app.replaceChildren(element('div', { class: 'workspace' },
    element('aside', { class: 'sidebar' },
      element('a', { class: 'wordmark', href: `#${sections[0].id}`, 'aria-label': 'Главная Garage' }, 'Garage', element('span', { 'aria-hidden': 'true' }, '/')),
      element('p', { class: 'sidebar-caption' }, owner ? 'Кабинет владельца' : 'Кабинет механика'), navigation,
      element('div', { class: 'sidebar-foot' }, element('span', { class: 'version-label' }, 'Рабочее пространство мастерской'), connection)),
    element('div', { class: 'workspace-body' },
      element('header', { class: 'workspace-header' },
        element('div', { class: 'identity' }, element('span', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 1).toLocaleUpperCase()),
          element('div', {}, element('span', { class: 'identity-name' }, name), element('span', { class: 'identity-role' }, owner ? 'Владелец' : 'Механик'))),
        element('div', { class: 'header-actions' },
          element('a', { class: 'account-link', href: 'account.html' }, 'Учётная запись'),
          element('button', { class: 'button button-small', onclick: () => controller.signOut() }, 'Выйти'))),
      element('main', { id: 'main-content', class: 'workspace-main' },
        element('div', { class: 'page-heading' }, element('p', { class: 'eyebrow' }, 'Заказы и работы'), title, description), content))));
  workspace = { navigation, title, description, content, updateConnection };
  updateWorkspace();
}

function showState(state) {
  disposeView();
  currentState = state;
  workspace = null;
  if (state.status === 'signed_out') {
    document.title = 'Вход · Garage';
    showLogin(state.message);
  } else if (state.status === 'ready') showWorkspace(state.profile);
  else if (state.status === 'error') showError(state.message);
  else {
    app.replaceChildren(element('main', { id: 'main-content', class: 'startup', 'aria-live': 'polite' },
      element('span', { class: 'wordmark' }, 'Garage/'), element('p', { class: 'muted' }, state.message || 'Открываем рабочее пространство…')));
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
    client = sb;
    controller = createAuthController(sb, { onChange: showState });
    await controller.start();
  } catch {
    showError('Проверьте подключение и повторите попытку. Для входа нужен интернет.');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
