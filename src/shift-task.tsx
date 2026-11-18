import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { actionError } from './order-shared.js';
import { actionLabel, confirmations, dayLabel, instantLabel, isTerminal, mine, participantLabel, participants, primaryAction, taskLabel, taskName } from './shift-model';
import type { GarageClient, Profile, TaskRow, TeamAction } from './shift-model';

interface DetailProps {
  row: TaskRow;
  profile: Profile;
  client: GarageClient;
  online: boolean;
  current: boolean;
  refresh(): Promise<void>;
  close(): void;
  openOrder(id: string): void;
}
interface ActionDraft { action: TeamAction; version: number; note: string; reassign?: boolean }
const saveLabels: Partial<Record<TeamAction, string>> = {
  confirm: 'Подтвердить выполнение', block: 'Сохранить причину', leave: 'Подтвердить возврат', note: 'Сохранить заметку'
};
export function TaskDetail({ row, profile, client, online, current, refresh, close, openOrder }: DetailProps) {
  const { task, order } = row;
  const owner = profile.role === 'admin';
  const personal = mine(task, profile.id);
  const team = participants(task);
  const reassignPrefix = 'Запрос переназначения: ';
  const originLabel = { mechanic: 'Подтверждено механиком', historical: 'Историческая запись', owner_recorded: 'Учтено владельцем' };
  const progress = confirmations(task);
  const primary = primaryAction(row, profile.id);
  const terminal = isTerminal(task) || order.status !== 'published';
  const canTalk = Boolean(task.can_see_notes && (owner || personal) && !terminal);
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState({ text: '', error: false });
  const [uncertain, setUncertain] = useState<ActionDraft | null>(null);
  const locks = useRef(false);
  const receipts = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const title = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { mounted.current = true; title.current?.focus({ preventScroll: true }); return () => { mounted.current = false; }; }, [task.id]);
  useLayoutEffect(() => { if (draft) (input.current || submitButton.current)?.focus(); }, [draft?.action]);
  const locked = !online || !current || saving;
  const conflict = Boolean(draft && task.version !== draft.version && !uncertain);

  function begin(action: TeamAction, reassign = false) {
    setFeedback({ text: '', error: false });
    const next = { action, version: task.version, note: '', reassign };
    if (saveLabels[action]) setDraft(next);
    else void execute(next);
  }
  function cancel() {
    setDraft(null);
    requestAnimationFrame(() => (primaryButton.current || title.current)?.focus({ preventScroll: true }));
  }
  async function execute(change: ActionDraft) {
    if (locks.current || !online || !current) return;
    const note = change.reassign ? reassignPrefix + change.note.trim() : change.note.trim();
    const args = { p_task_id: task.id, p_action: change.action, p_expected_version: change.version, p_note: note };
    const fingerprint = JSON.stringify(args);
    if (!receipts.current.has(fingerprint)) receipts.current.set(fingerprint, crypto.randomUUID());
    locks.current = true;
    setSaving(true);
    let committed = false;
    try {
      const response = await client.rpc('garage_team_action', { ...args, p_request_id: receipts.current.get(fingerprint) });
      if (response.error) throw response.error;
      committed = true;
      receipts.current.delete(fingerprint);
      if (mounted.current) {
        setDraft(null);
        setUncertain(null);
        setFeedback({ text: change.action === 'confirm' ? 'Ваше выполнение подтверждено.' : change.action === 'note' ? 'Заметка сохранена.' : 'Изменение сохранено.', error: false });
        title.current?.focus({ preventScroll: true });
      }
    } catch (cause) {
      if (mounted.current) {
        const error = cause as { code?: string; message?: string };
        const ambiguous = !error.code || /network|fetch|timeout/i.test(error.message || '');
        setUncertain(ambiguous ? change : null);
        if (!ambiguous) receipts.current.delete(fingerprint);
        setFeedback({ text: /without financial information/i.test(error.message || '') ? 'В заметке команды допускаются только сведения о работе. Уберите сведения об оплате и повторите отправку.' : actionError(error), error: true });
      }
    } finally {
      if (mounted.current) await refresh();
      locks.current = false;
      if (mounted.current) {
        setSaving(false);
        if (committed) setDraft(null);
      }
    }
  }
  const managerText = order.manager_comment;
  const separateInstructions = order.instructions && order.instructions !== managerText && !(order.instructions_from_manager && order.manager_comment_updated_at);
  return <article class="shift-detail" aria-labelledby="shift-task-title" data-task-detail={task.id}>
    <div class="shift-detail-top"><button type="button" class="button shift-back" onClick={close} disabled={saving}>← К списку</button><span class="shift-code">{order.order_number}</span></div>
    <div class="shift-detail-head"><div class="shift-priority-line"><span class={`task-status status-${task.status}`}>{taskLabel[task.status] || 'Состояние уточняется'}</span>
      {order.priority === 'urgent' && <span class="priority priority-urgent">Срочно</span>}</div>
      <h2 data-route-heading id="shift-task-title" ref={title} tabIndex={-1}>{taskName(task)}</h2><p class="shift-vehicle-name">{order.vehicle}</p>
    </div>
    <div class="shift-actions" aria-label="Действия с работой">
      {!draft && !uncertain && <div class="shift-button-strip">
        {owner ? <button class="button button-primary" onClick={() => openOrder(order.id)}>Открыть заказ</button> : primary && <button ref={primaryButton} class="button button-primary" disabled={locked} onClick={() => begin(primary)}>{primary === 'join' && !team.length ? 'Начать работу' : actionLabel[primary]}</button>}
        {!owner && personal === 'working' && !terminal && <button class="button" disabled={locked} onClick={() => begin('block')}>{actionLabel.block}</button>}
      </div>}
      {!owner && !draft && !uncertain && personal === 'confirmed' && <p class="shift-hint">{terminal ? 'Ваше выполнение учтено.' : 'Вы подтвердили свою работу. Ожидаем остальных участников.'}</p>}
      {draft && !uncertain && <form class="shift-action-form" onSubmit={e => { e.preventDefault(); if (!conflict) void execute(draft); }}>
        {draft.action === 'confirm' ? <p>Подтвердите выполнение своей части работы на автомобиле <strong>{order.vehicle}</strong>.</p> : <label>{draft.reassign ? 'Причина запроса на переназначение' : draft.action === 'note' ? 'Текст заметки' : 'Причина'}
          <textarea ref={input} value={draft.note} required maxLength={draft.reassign ? 2000 - reassignPrefix.length : 2000} onInput={e => setDraft({ ...draft, note: e.currentTarget.value })}/></label>}
        {conflict && <div class="notice notice-error" role="alert">Работа изменилась. Проверьте состав и состояние. Введённый текст сохранён.
          <button type="button" class="button" onClick={() => setDraft({ ...draft, version: task.version })} disabled={locked}>Я проверил изменения</button></div>}
        <div class="shift-button-strip"><button class="button button-primary" ref={submitButton} disabled={locked || conflict || (draft.action !== 'confirm' && !draft.note.trim())}>
          {saving ? 'Сохраняем…' : draft.reassign ? 'Отправить запрос' : saveLabels[draft.action]}</button><button type="button" class="button" disabled={saving} onClick={cancel}>Отмена</button></div>
      </form>}
      {uncertain && <button type="button" class="button" disabled={locked} onClick={() => void execute(uncertain)}>Повторить отправку</button>}
      <p class={feedback.error ? 'shift-alert' : 'shift-saved'} role="status">{feedback.text}</p>
      {!online && <p class="shift-alert">Нет сети. Для отправки требуется подключение.</p>}
    </div>
    {(order.due_date || order.planned_date || order.vin || order.colour || order.vehicle_group_name) && <dl class="shift-facts">
      {([['Срок', dayLabel(order.due_date)], ['План', dayLabel(order.planned_date)], ['VIN', order.vin], ['Цвет', order.colour], ['Группа', order.vehicle_group_name]] as const).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>}
    {(separateInstructions || task.instructions || managerText) && <section class="shift-detail-section"><h3>Указания</h3>{separateInstructions && <p>{order.instructions}</p>}{task.instructions && <p>{task.instructions}</p>}
      {managerText && <div class="shift-instruction"><h4>Комментарий менеджера</h4><p>{managerText}</p></div>}</section>}
    <section class="shift-detail-section"><div class="shift-section-heading"><h3>Команда</h3>{team.length > 0 && <span class="shift-count">{progress.count} из {progress.total} подтвердили</span>}</div>
      {team.length ? <ul class="shift-team">{team.map(member => <li key={member.mechanic_id}><span>{member.name || 'Механик'}{member.mechanic_id === profile.id ? ' · Вы' : ''}
          {member.confirmed_at && <small>{member.confirmation_origin ? originLabel[member.confirmation_origin] + ' · ' : ''}{instantLabel(member.confirmed_at)}</small>}
          {task.can_see_notes && member.status === 'blocked' && member.blocker_reason && <small>{member.blocker_reason}</small>}</span><span class={`task-status member-${member.status}`}>{participantLabel[member.status]}</span></li>)}</ul>
        : <p class="shift-hint">Пока никто не присоединился.</p>}
      {task.roster_locked && !terminal && <p class="shift-hint">Самостоятельное присоединение закрыто после первого подтверждения.</p>}
    </section>
    {(owner || personal) && task.blocker_reason && task.status === 'blocked' && <section class="shift-detail-section"><h3>Причина приостановки</h3><p>{task.blocker_reason}</p></section>}
    {task.can_see_notes && <section class="shift-detail-section"><div class="shift-section-heading"><h3>Заметки команды</h3>{canTalk && !draft && !uncertain && <button class="button" disabled={locked} onClick={() => begin('note')}>{actionLabel.note}</button>}</div>
      {(task.notes || []).length ? <ol class="shift-notes">{task.notes!.map(item => <li key={item.id}><strong>{item.name || 'Механик'}</strong> <time dateTime={item.created_at}>{instantLabel(item.created_at)}</time><p>{item.note}</p></li>)}</ol> : <p class="shift-hint">Заметок пока нет.</p>}
    </section>}
    {!owner && personal && personal !== 'confirmed' && !terminal && !draft && !uncertain && <div class="shift-secondary-actions">
      {order.source === 'manager' && !task.roster_locked && <button class="button" disabled={locked} onClick={() => begin('leave')}>{actionLabel.leave}</button>}
      {order.source === 'owner' && canTalk && <button class="button" disabled={locked} onClick={() => begin('note', true)}>Запросить переназначение</button>}
    </div>}
  </article>;
}
