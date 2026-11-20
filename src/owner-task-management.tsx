import { useRef, useState } from 'preact/hooks';
import { participants, instantLabel, type Task } from './shift-model';
import { errorText, type Mutate, type OwnerOrder, type Staff } from './owner-model';

export interface TaskManagementProps {
  task: Task;
  order: OwnerOrder;
  staff: Staff[];
  mutate: Mutate;
  reload(): Promise<void>;
  notify(text: string): void;
}
export function TaskManagement({ task, order, staff, mutate, reload, notify }: TaskManagementProps) {
  const [action, choose] = useState(''),
    [person, setPerson] = useState(''),
    [replacement, setReplacement] = useState(''),
    [reason, setReason] = useState('');
  const [version, setVersion] = useState(task.version),
    [err, setErr] = useState(''),
    [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const members = participants(task),
    adjustable = members.filter((m) => m.status !== 'confirmed'),
    others = staff.filter((s) => !members.some((m) => m.mechanic_id === s.id));
  function select(value: string) {
    choose(value);
    setPerson(value === 'assign' ? '' : adjustable.length === 1 ? adjustable[0].mechanic_id : '');
    setReplacement('');
    setReason('');
    setErr('');
    setVersion(task.version);
  }
  const labels: Record<string, string> = {
    assign: 'Добавить исполнителя',
    remove: 'Снять исполнителя',
    replace: 'Переназначить',
    cancel: 'Отменить работу',
    note: 'Добавить заметку',
  };
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (sending.current || !reason.trim() || task.version !== version) return;
    sending.current = true;
    setBusy(true);
    setErr('');
    try {
      if (action === 'cancel')
        await mutate('garage_task_action', {
          p_task_id: task.id,
          p_action: 'cancel',
          p_expected_version: version,
          p_note: reason.trim(),
          p_assignee: null,
        });
      else
        await mutate('garage_team_action', {
          p_task_id: task.id,
          p_action: action,
          p_expected_version: version,
          p_note: reason.trim(),
          p_mechanic_id: action === 'note' ? null : person,
          p_replacement_id: action === 'replace' ? replacement : null,
        });
      choose('');
      notify(action === 'cancel' ? 'Работа отменена.' : action === 'note' ? 'Заметка сохранена.' : 'Состав команды обновлён.');
      await reload();
    } catch (error) {
      setErr(errorText(error));
      await reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div class="job-management">
      {task.notes?.filter(n => n.note).map(n => (
        <p key={n.id}>{instantLabel(n.created_at)} · {n.name}: {n.note}</p>
      ))}
      {order.status === 'published' && !['completed', 'cancelled'].includes(task.status) && (
        <div class="task-actions">
          {task.can_see_notes && (
            <button type="button" class="button" onClick={() => select('note')}>{labels.note}</button>
          )}
          {others.length > 0 && order.source === 'owner' && !task.roster_locked && (
            <button type="button" class="button" onClick={() => select('assign')}>
              {labels.assign}
            </button>
          )}
          {adjustable.length > 0 && others.length > 0 && (
            <button type="button" class="button" onClick={() => select('replace')}>
              {labels.replace}
            </button>
          )}
          {adjustable.length > 0 && (members.length > 1 || order.source === 'manager') && (
            <button type="button" class="button" onClick={() => select('remove')}>
              {labels.remove}
            </button>
          )}
          <button type="button" class="button" onClick={() => select('cancel')}>
            {labels.cancel}
          </button>
        </div>
      )}
      {action && (
        <form class="inline-action" onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>{labels[action]}</legend>
            {(action === 'assign' || action === 'replace' || action === 'remove') && (
              <label>
                {action === 'assign' ? 'Новый механик' : 'Участник команды'}
                <select required value={person} onChange={(e) => setPerson(e.currentTarget.value)}>
                  <option value="">Выберите механика</option>
                  {(action === 'assign'
                    ? others
                    : adjustable.map((m) => ({ id: m.mechanic_id, name: m.name }))
                  ).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === 'replace' && (
              <label>
                Новый механик
                <select required value={replacement} onChange={(e) => setReplacement(e.currentTarget.value)}>
                  <option value="">Выберите механика</option>
                  {others.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {action === 'note' ? 'Текст заметки' : 'Причина'}
              <textarea
                required
                maxLength={action === 'note' ? 2000 : 1000}
                value={reason}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            </label>
            {version !== task.version && (
              <div class="notice">
                <p>Состояние работы изменилось. Проверьте участников.</p>
                <button type="button" class="button" onClick={() => setVersion(task.version)}>
                  Использовать актуальную версию
                </button>
              </div>
            )}
            {err && <p role="alert">{err}</p>}
            <button type="submit" class="button button-primary" disabled={version !== task.version}>
              {action === 'replace'
                ? 'Подтвердить переназначение'
                : action === 'cancel'
                  ? 'Подтвердить отмену'
                  : action === 'note' ? 'Сохранить заметку' : 'Сохранить изменение'}
            </button>{' '}
            <button type="button" class="button" onClick={() => choose('')}>
              Оставить без изменений
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
