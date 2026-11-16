export const LOCALE = 'ru-RU';

// Browser validation messages otherwise depend on the browser's own language.
export function installRussianValidation(root = document) {
  root.addEventListener('input', event => event.target.setCustomValidity?.(''), true);
  root.addEventListener('invalid', event => {
    const control = event.target, state = control.validity;
    if (!state || typeof control.setCustomValidity !== 'function') return;
    let message = 'Проверьте введённое значение.';
    if (state.valueMissing) message = control.type === 'checkbox' ? 'Отметьте этот пункт.' : 'Заполните это поле.';
    else if (state.typeMismatch) message = control.type === 'email' ? 'Введите корректный адрес электронной почты.' : 'Введите корректный адрес.';
    else if (state.tooShort) message = `Введите не менее ${control.minLength} символов.`;
    else if (state.tooLong) message = `Введите не более ${control.maxLength} символов.`;
    else if (state.rangeUnderflow) message = `Значение должно быть не меньше ${control.min}.`;
    else if (state.rangeOverflow) message = `Значение должно быть не больше ${control.max}.`;
    else if (state.badInput || state.stepMismatch) message = 'Введите корректное число.';
    control.setCustomValidity(message);
  }, true);
}
