import { compareOrderDays, formatOrderDay, orderDay } from './order-calendar';
import type { OwnerIntake } from './owner-model';
import './owner-intakes.css';

export function isPendingManagerIntake(intake: OwnerIntake) {
  return intake.status === 'pending' && !intake.order_id;
}

const intakeIssues: Record<string, string> = {
  NO_APPROVED_TASKS: 'Выберите запрошенные менеджером работы из каталога.',
  INVALID_PLANNED_DATE: 'Укажите полную плановую дату.',
  INVALID_VIN: 'Подтвердите VIN автомобиля.',
  INVALID_MANAGER: 'Подтвердите имя менеджера.',
  INVALID_VEHICLE: 'Укажите автомобиль.',
  UNKNOWN_VEHICLE_GROUP: 'Выберите подходящую группу автомобилей.',
  DUPLICATE_SOURCE_KEY: 'Проверьте повторяющиеся строки таблицы перед публикацией.',
};

export function IntakeIssues({ intake }: { intake: OwnerIntake }) {
  const issues = [...new Set(intake.issues)];
  return <>
    {intake.source_changed && <p class="notice">Заявка в таблице изменилась. Сверьте исходный и актуальный текст.</p>}
    {issues.length > 0 && <ul>{issues.map(issue =>
      <li key={issue}>{intakeIssues[issue] || 'Проверьте исходную заявку.'}</li>
    )}</ul>}
  </>;
}

export function ManagerIntakes({ intakes, failed, retry, attention = false }: {
  intakes: OwnerIntake[] | null;
  failed: boolean;
  retry(): void;
  attention?: boolean;
}) {
  const pending = (intakes ?? []).filter(isPendingManagerIntake).map(intake => ({
    intake,
    vehicle: String(intake.suggested_order?.vehicle || intake.latest?.vehicle || intake.original?.vehicle || 'Автомобиль не указан'),
    day: orderDay(intake.suggested_order || {}),
  })).sort((a, b) => compareOrderDays(a.day, b.day) || a.vehicle.localeCompare(b.vehicle, 'ru') || a.intake.id.localeCompare(b.intake.id));
  if (!attention && !failed && !pending.length) return null;

  const Heading = attention ? 'h3' : 'h2';
  return <section class="owner-intakes" aria-labelledby="owner-intakes-heading">
    <Heading id="owner-intakes-heading">Заявки менеджеров</Heading>
    {failed ? <p class="notice" role="alert">Не удалось загрузить заявки менеджеров.{' '}
      <button type="button" class="button" onClick={retry}>Повторить загрузку заявок</button>
    </p> : pending.length ? <ul class="owner-intake-list">{pending.map(({ intake, vehicle, day }) => {
      const manager = intake.suggested_order?.manager_label || intake.latest?.manager_label || intake.original?.manager_label;
      const origin = [String(manager || ''), intake.source_name, intake.row_numbers?.length && 'Строки ' + intake.row_numbers.join(', ')].filter(Boolean);
      return <li class="owner-board-card" key={intake.id} data-manager-intake-id={intake.id}>
        <a class="owner-intake-link" href={'#orders/intake-' + encodeURIComponent(intake.id) + '/review'}>
          <span class="owner-intake-label">
            <strong>{vehicle}</strong>
            {(day || origin.length > 0) && <small>
              {day && <time dateTime={day}>{formatOrderDay(day)}</time>}
              {day && origin.length > 0 && ' · '}{origin.join(' · ')}
            </small>}
          </span>
          <span class="owner-intake-action">Проверить заявку</span>
        </a>
      </li>;
    })}</ul> : <p class="owner-board-empty" role={intakes ? undefined : 'status'}>
      {intakes ? 'Нет заявок на проверке.' : 'Загружаем заявки менеджеров…'}
    </p>}
  </section>;
}
