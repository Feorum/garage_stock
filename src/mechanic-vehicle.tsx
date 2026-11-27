import { useLayoutEffect, useRef } from 'preact/hooks';
import { ExecutorMarker } from './executor-marker';
import type { BoardOrder, BoardTask } from './mechanic-board-data';
import { instantLabel, participants, taskName } from './shift-model';
import { WorkChecklist } from './shift-vehicle';

export interface Draft {
  version: number;
  note: string;
}

export function WorkRow({
  task,
  ownId,
  readOnly,
  disabled,
  pending,
  toggle,
}: {
  task: BoardTask;
  ownId: string;
  readOnly: boolean;
  disabled: boolean;
  pending: boolean;
  toggle(checked: boolean): void;
}) {
  const checked = participants(task).filter((person) => person.status === 'confirmed');
  const ownCheck = task.my_status === 'confirmed' || checked.some((person) => person.mechanic_id === ownId);
  const allowed = !readOnly && task.status !== 'cancelled' &&
    (ownCheck ? task.can_uncheck_work : task.can_check_work);
  const name = taskName(task);
  const markers = checked.length > 0 && (
    <span class="mb-executors" id={'mb-executors-' + task.id}>
      {checked.map((person) => (
        <ExecutorMarker key={person.mechanic_id} id={person.mechanic_id} name={person.name} color={person.color} />
      ))}
    </span>
  );
  return (
    <li data-task-id={task.id}>
      {allowed ? (
        <button
          type="button"
          class="mb-work mb-check"
          role="checkbox"
          aria-checked={ownCheck}
          aria-label={name}
          aria-describedby={checked.length ? 'mb-executors-' + task.id : undefined}
          aria-busy={pending}
          disabled={disabled || pending}
          onClick={() => toggle(!ownCheck)}
        >
          <span class="mb-box" aria-hidden="true">
            {ownCheck ? '✓' : pending ? '…' : ''}
          </span>
          <span class="mb-work-name">{name}</span>
          {markers}
        </button>
      ) : (
        <div class="mb-work" role="group" aria-label={name} tabIndex={-1}>
          <span class="mb-work-name">{name}</span>
          {markers}
          {task.status === 'cancelled' && <small>Отменено</small>}
        </div>
      )}
      {task.status === 'blocked' && task.can_see_notes && task.blocker_reason && (
        <p class="mb-blocked">{task.blocker_reason}</p>
      )}
    </li>
  );
}

export function Instructions({ order }: { order: BoardOrder }) {
  const general =
    order.instructions &&
    order.instructions !== order.manager_comment &&
    !(order.instructions_from_manager && order.manager_comment_updated_at) &&
    order.instructions;
  const written = order.tasks.filter((task) => task.instructions || (task.can_see_notes && !!task.notes?.length));
  if (!general && !written.length && !order.manager_comment) return null;
  return (
    <details class="mb-instructions">
      <summary>Указания и заметки</summary>
      {general && (
        <div>
          <h4>Указания к заказу</h4>
          <p>{general}</p>
        </div>
      )}
      {order.manager_comment && (
        <div>
          <h4>Комментарий менеджера</h4>
          <p>{order.manager_comment}</p>
        </div>
      )}
      {written.map((task) => (
        <div key={task.id}>
          <h4>{taskName(task)}</h4>
          {task.instructions && <p>{task.instructions}</p>}
          {task.can_see_notes &&
            task.notes?.map((note) => (
              <p key={note.id}>
                <strong>{note.name || 'Механик'}</strong> · {instantLabel(note.created_at)}
                <br />
                {note.note}
              </p>
            ))}
        </div>
      ))}
    </details>
  );
}

export function HandoffForm({
  order,
  draft,
  disabled,
  sending,
  update,
  cancel,
  confirm,
}: {
  order: BoardOrder;
  draft: Draft;
  disabled: boolean;
  sending: boolean;
  update(draft: Draft): void;
  cancel(): void;
  confirm(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const title = heading.current;
    if (!title) return;
    title.focus({ preventScroll: true });
    const form = title.closest('form')!.getBoundingClientRect();
    const nav = document.querySelector('nav[data-workspace-role="mechanic"]')?.getBoundingClientRect();
    const navAtBottom = nav && nav.top > window.innerHeight / 2 && nav.bottom >= window.innerHeight - 2;
    const bottom = (navAtBottom ? nav.top : window.innerHeight) - 12;
    if (form.height > bottom - 12 || form.top < 12) window.scrollBy(0, form.top - 12);
    else if (form.bottom > bottom) window.scrollBy(0, form.bottom - bottom);
  }, []);
  const stale = draft.version !== order.version;
  return (
    <form
      class="vehicle-handoff mb-handoff-form"
      aria-labelledby="mb-handoff-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !stale) confirm();
      }}
    >
      <h3 id="mb-handoff-heading" ref={heading} tabIndex={-1}>
        Передача владельцу
      </h3>
      <WorkChecklist tasks={order.tasks} confirmation />
      <label>
        Комментарий владельцу <span class="shift-hint">(необязательно)</span>
        <textarea
          value={draft.note}
          maxLength={2000}
          disabled={sending}
          onInput={(event) => update({ ...draft, note: event.currentTarget.value })}
        />
      </label>
      {stale && (
        <div class="shift-alert" role="status">
          Список работ изменился. Проверьте обновлённый список и комментарий.
          <button
            type="button"
            class="button"
            disabled={disabled}
            onClick={() => update({ ...draft, version: order.version })}
          >
            Я проверил изменения
          </button>
        </div>
      )}
      <div class="work-decisions">
        <button type="button" class="button" disabled={sending} onClick={cancel}>
          Отмена
        </button>
        <button type="submit" class="button button-primary" disabled={disabled || stale}>
          Передать владельцу
        </button>
      </div>
    </form>
  );
}
