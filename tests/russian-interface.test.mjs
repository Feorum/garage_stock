import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authErrorMessage } from '../src/auth.js';
import { installRussianValidation, LOCALE } from '../src/locale.js';

test('authentication failures use Russian messages without exposing upstream text', () => {
  const message = authErrorMessage({ code: 'invalid_credentials', message: 'Invalid login credentials' });
  assert.match(message, /Неверный/);
  assert.match(authErrorMessage({ code: 'email_not_confirmed' }), /Подтвердите/);
  assert.match(authErrorMessage({ status: 429 }), /Слишком много/);
  assert.doesNotMatch(authErrorMessage({ message: 'Upstream private diagnostic' }), /Upstream|private/);
});

test('native validation uses Russian and clears after input corrections', () => {
  const listeners = {};
  installRussianValidation({ addEventListener: (name, handler) => { listeners[name] = handler; } });
  const control = { validity: { typeMismatch: true }, type: 'email', setCustomValidity(message) { this.message = message; } };
  listeners.invalid({ target: control });
  assert.match(control.message, /электронной почты/);
  listeners.input({ target: control });
  assert.equal(control.message, '');
  control.validity = { valueMissing: true };
  listeners.invalid({ target: control });
  assert.equal(control.message, 'Заполните это поле.');
});

test('startup and account documents declare the Russian-only interface', () => {
  assert.equal(LOCALE, 'ru-RU');
  for (const name of ['index.html', 'account.html']) {
    const html = fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    assert.match(html, /<html lang="ru">/);
    assert.doesNotMatch(html, /Skip to content|Set your password|Opening your workspace/);
  }
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.lang, 'ru');
});
