const SHEET_ID = /^[A-Za-z0-9_-]{20,200}$/;
export const TAB_ID = /^\d{1,10}$/;
export const READER_GUIDE = 'https://github.com/Feorum/garage_stock/tree/main/integrations/existing-google-sheet';

export function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function parseSpreadsheetId(value) {
  const input = String(value || '').trim();
  if (SHEET_ID.test(input)) return input;
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && match && SHEET_ID.test(match[1])) return match[1];
  } catch { /* A malformed URL is an input error. */ }
  return null;
}

export function parseSheetGid(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!parseSpreadsheetId(value)) return null;
    const gid = new URLSearchParams(url.hash.slice(1)).get('gid') ?? url.searchParams.get('gid');
    return TAB_ID.test(gid || '') && Number(gid) <= 2147483647 ? Number(gid) : null;
  } catch { return null; }
}

export function feedbackMessage(error) {
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'Подключения таблиц пока недоступны. Обновите страницу после завершения настройки.';
  if (error?.code === '42501') return 'У вашей учётной записи нет доступа к управлению подключением. Войдите как владелец и повторите попытку.';
  if (error?.code === '40001' || /version|changed|conflict/i.test(error?.message || '')) return 'Подключение изменилось. Обновите его настройки и повторите попытку.';
  if (error?.code === '23505' || /already registered|already exists/i.test(error?.message || '')) return 'Эта таблица уже подключена. Найдите её подключение ниже.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'Не удалось подтвердить изменение. Оставьте страницу открытой и повторите то же действие.';
  return 'Не удалось обновить подключение. Проверьте название, ссылку на таблицу и идентификатор листа, затем повторите попытку.';
}

export const REVIEW_MESSAGES = {
  NONSTANDARD_TASK_DETAIL: 'Дополнительные указания меняют выбранный объём или размеры работы. Владельцу нужно уточнить запрос: он не будет автоматически считаться полной оклейкой капота или полосой 25 либо 45 см.',
  UNKNOWN_WRAPPING_WORK: 'Выберите работу по оклейке из утверждённого списка.',
  UNKNOWN_TINT_WORK: 'Выберите утверждённую тонировку задней полусферы и явно укажите 5% или 15%.',
  INVALID_PLANNED_DATE: 'Укажите корректную планируемую дату.',
  INVALID_VIN: 'Укажите корректный идентификационный номер автомобиля.',
  INVALID_COMPLETION_FLAG: 'Установите или снимите отметку о выполнении в соответствующей ячейке.',
  INVALID_MANAGER: 'Сократите имя менеджера до допустимой длины.',
  INVALID_VEHICLE: 'Сократите описание автомобиля до допустимой длины.',
  FIELD_TOO_LONG: 'Сократите описание автомобиля, работы или указания до допустимой длины.',
  NO_APPROVED_TASKS: 'Выберите хотя бы одну работу из утверждённого списка.',
  WORK_UNAVAILABLE_FOR_VEHICLE: 'Эта работа недоступна для выбранной модели автомобиля.',
  SOURCE_PROGRESS_REQUIRES_REVIEW: 'В примечаниях указано, что работы могли быть выполнены. Владельцу нужно проверить их состояние.',
  CONFIDENTIAL_NOTE_REQUIRES_REVIEW: 'Примечание может содержать закрытые финансовые данные. Владельцу нужно проверить его перед передачей запроса механикам.',
  CONFLICTING_HOOD_SCOPE: 'Выберите один вариант оклейки капота для этого запроса.',
  CONFLICTING_TINT_OPTIONS: 'Выберите один процент тонировки для этого запроса.',
  MALFORMED_WORK_LIST: 'Проверьте выбранные работы и разделители в списке.',
  TASK_DETAIL_TARGET_MISSING: 'Дополнительное указание относится к работе, которая не выбрана.',
  AMBIGUOUS_TASK_DETAIL_TAG: 'Уточните, к какой выбранной работе относится дополнительное указание.',
  INVALID_TASK_DETAIL_TAG: 'Укажите корректную ссылку на утверждённую работу для дополнительного указания.',
  DUPLICATE_TASK_DETAIL_TAG: 'Объедините дополнительные указания к одной работе в одну запись.',
  EMPTY_TASK_DETAIL: 'Добавьте текст указания к выбранной работе или удалите пустую ссылку.',
  TASK_DETAIL_TOO_LONG: 'Сократите дополнительное указание к работе.',
  SOURCE_IDENTITY_CHANGED: 'Данные о визите автомобиля изменились или неоднозначны. Владельцу нужно проверить их.',
  COMPLETED_HISTORY_REOPENED: 'Этот визит уже завершён в исходной истории. Перед созданием новых работ его должен проверить владелец.',
  SOURCE_MARKED_COMPLETED: 'В исходной таблице импортированный визит отмечен как завершённый. Владельцу нужно сверить его с приложением: отметка в таблице не завершает задачи в приложении.',
  DUPLICATE_SOURCE_IDENTITY: 'Несколько строк описывают один визит автомобиля. Владельцу нужно сверить их.',
  DUPLICATE_SOURCE_KEY: 'Несколько строк описывают один визит автомобиля. Владельцу нужно сверить их.',
  DELIVERY_PENDING: 'Ожидается подтверждение передачи. Повторная попытка будет выполнена автоматически.',

  invalid_or_missing_vin: 'Укажите корректный идентификационный номер автомобиля.',
  date_missing_or_ambiguous: 'Уточните планируемую дату.',
  missing_vehicle_group: 'Выберите модель автомобиля из утверждённого списка.',
  unknown_vehicle_group: 'Выберите модель автомобиля из утверждённого списка.',
  ambiguous_atlas_group: 'Выберите точную модель автомобиля из утверждённого списка.',
  model_alias_requires_confirmation: 'Уточните модель автомобиля по утверждённому списку.',
  unapproved_finish_variant: 'Запрошенный вариант плёнки должен проверить владелец.',
  unrecognized_scope_fragment: 'Уточните запрошенную работу по утверждённому списку.',
  work_alias_requires_confirmation: 'Уточните запрошенную работу по утверждённому списку.',
  unsupported_hood_width: 'Выберите утверждённый вариант оклейки капота.',
  unsupported_tint_percentage: 'Выберите утверждённый процент тонировки: 5% или 15%.',
  tint_percentage_required: 'Выберите процент тонировки: 5% или 15%.',
  tint_scope_requires_confirmation: 'Уточните вариант тонировки по утверждённому списку.',
  unavailable_work: 'Эта работа недоступна для выбранной модели автомобиля.',
  work_unavailable_for_model: 'Эта работа недоступна для выбранной модели автомобиля.',
  partial_completion_in_notes: 'В примечаниях указано, что работы могли быть выполнены. Проверьте их вместе с владельцем.',
  partial_work_in_notes: 'В примечаниях указано, что работы могли быть выполнены. Проверьте их вместе с владельцем.',
  duplicate_source_identity: 'Несколько строк описывают один визит автомобиля. Владельцу нужно сверить их.',
  ambiguous_source_identity: 'Данные о визите автомобиля изменились или неоднозначны. Владельцу нужно проверить их.',
  missing_requested_work: 'Выберите хотя бы одну работу из утверждённого списка.',
  no_tasks: 'Выберите хотя бы одну работу из утверждённого списка.',
  formula_or_error_in_input: 'Замените формулу или ошибку в данных заказа корректным выбором.',
  ORDER_CHANGED: 'Заказ изменился в приложении. Владельцу нужно проверить запрошенное изменение.',
  ORDER_CLOSED: 'Заказ закрыт в приложении. Владельцу нужно проверить эту строку.',
  VALIDATION_FAILED: 'Проверьте модель автомобиля и выбранные работы из утверждённого списка.',
};

export function connectionUrl(source, row) {
  if (!SHEET_ID.test(String(source.spreadsheet_id || ''))) return null;
  const gid = Number(source.sheet_gid);
  if (!Number.isSafeInteger(gid) || gid < 0 || gid > 2147483647) return null;
  const rowNumber = Number(row);
  const range = Number.isSafeInteger(rowNumber) && rowNumber > 0 ? `&range=A${rowNumber}:J${rowNumber}` : '';
  return `https://docs.google.com/spreadsheets/d/${source.spreadsheet_id}/edit#gid=${gid}${range}`;
}
