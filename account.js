import { sb } from './src/supabase.js';
import { installRussianValidation } from './src/locale.js';

installRussianValidation();

const callback = new URL(location.href);
const fragment = new URLSearchParams(callback.hash.slice(1));
const callbackError = fragment.has('error') || fragment.has('error_description') ||
  callback.searchParams.has('error') || callback.searchParams.has('error_description');
const unsupportedCallback = callback.searchParams.has('code') || callback.searchParams.has('token_hash');

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
  intro.textContent = 'Ссылка отсутствует, недействительна или срок её действия истёк.';
  tell('Ссылка действует один раз. Если пароль уже задан, откройте Garage и войдите. Иначе попросите владельца прислать новую ссылку.', true);
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
    intro.textContent = 'Придумайте пароль длиной не менее 12 символов.';
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
  if (password.value.length < 12) return tell('Используйте не менее 12 символов.', true);
  if (password.value !== confirmation.value) return tell('Пароли не совпадают.', true);
  save.disabled = true;
  tell('Сохраняем пароль…');
  try {
    const { error } = await sb.auth.updateUser({ password: password.value });
    if (error) {
      tell('Не удалось сохранить пароль. Повторите попытку или запросите новую ссылку.', true);
      return;
    }
    document.getElementById('title').textContent = 'Пароль сохранён';
    intro.textContent = 'Учётная запись готова. Можно открыть Garage.';
    tell('При следующем входе используйте адрес электронной почты и новый пароль.');
    form.hidden = true;
    openApp.hidden = false;
  } catch {
    tell('Сервис учётных записей недоступен. Проверьте подключение и повторите попытку.', true);
  } finally {
    password.value = '';
    confirmation.value = '';
    save.disabled = false;
  }
});

initialize();
