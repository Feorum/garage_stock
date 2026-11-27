import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createOwnerWidget, widgetKinds, widgetMetricOptions, widgetTitle, widgetTitleLimit, withWidgetMetric,
  type OwnerWidget, type WidgetKind } from './owner-widget-model';
import './owner-widget-editor.css';

interface WidgetEditorProps {
  widgets: readonly OwnerWidget[];
  onChange: (widgets: readonly OwnerWidget[]) => void;
  ready: boolean;
  allowMonthly?: boolean;
}

export function OwnerWidgetEditor({ widgets, onChange, ready, allowMonthly = false }: WidgetEditorProps) {
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const addButtons = useRef<HTMLDivElement>(null);
  const focusAfterEdit = useRef<string | null>(null);
  const [draft, setDraft] = useState<readonly OwnerWidget[] | null>(null);
  const editing = draft !== null;
  const availableKinds = (Object.entries(widgetKinds) as [WidgetKind, string][])
    .filter(([kind]) => kind !== 'monthly' || allowMonthly);

  useLayoutEffect(() => {
    if (editing && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [editing]);

  useLayoutEffect(() => {
    const next = focusAfterEdit.current;
    if (next === null) return;
    focusAfterEdit.current = null;
    const field = Array.from(dialog.current?.querySelectorAll<HTMLSelectElement>('[data-edit-widget]') ?? [])
      .find(element => element.dataset.editWidget === next);
    (field ?? addButtons.current?.querySelector('button'))?.focus();
  }, [draft]);

  function add(kind: WidgetKind) {
    if (!draft) return;
    const id = globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random().toString(36).slice(2);
    focusAfterEdit.current = id;
    setDraft([...draft, createOwnerWidget(kind, id)]);
  }

  function update(id: string, edit: (widget: OwnerWidget) => OwnerWidget) {
    setDraft(current => current?.map(widget => widget.id === id ? edit(widget) : widget) ?? null);
  }

  function move(index: number, offset: number) {
    if (!draft) return;
    const target = index + offset;
    if (target < 0 || target >= draft.length) return;
    const reordered = [...draft];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    focusAfterEdit.current = draft[index].id;
    setDraft(reordered);
  }

  function remove(index: number) {
    if (!draft) return;
    focusAfterEdit.current = (draft[index + 1] ?? draft[index - 1])?.id ?? '';
    setDraft(draft.filter((_, position) => position !== index));
  }

  function close() {
    setDraft(null);
    trigger.current?.focus();
  }

  return <>
    <button class="button button-small dash-widget-trigger" type="button" ref={trigger} disabled={!ready}
      aria-haspopup="dialog" onClick={() => setDraft(widgets)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6m6 4v6" /></svg>
      Настроить виджеты
    </button>
    {draft && <dialog class="dash-widget-dialog" ref={dialog} aria-labelledby={titleId} onClose={close}>
      <form onSubmit={event => {
        event.preventDefault();
        onChange(draft.map(widget => ({ ...widget, title: widget.title.trim() })));
        dialog.current?.close();
      }}>
        <h2 id={titleId}>Виджеты вкладки</h2>
        <div class="dash-widget-add" ref={addButtons} role="group" aria-label="Добавить виджет">
          {availableKinds.map(([kind, name]) =>
            <button class="button button-small" type="button" key={kind} onClick={() => add(kind)}
              aria-label={'Добавить виджет «' + name + '»'}>+ {name}</button>)}
        </div>
        {draft.length ? <ol class="dash-widget-list">
          {draft.map((widget, index) => <li key={widget.id}>
            <fieldset>
              <legend>{index + 1}. {widgetKinds[widget.kind]}</legend>
              <div class="dash-widget-fields">
                <div>
                  <label for={titleId + '-metric-' + index}>Данные</label>
                  <select id={titleId + '-metric-' + index} value={widget.metric} data-edit-widget={widget.id}
                    onChange={event => {
                      const metric = event.currentTarget.value;
                      update(widget.id, current => withWidgetMetric(current, metric));
                    }}>
                    {widgetMetricOptions(widget.kind).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
                  </select>
                </div>
                <div>
                  <label for={titleId + '-title-' + index}>Название</label>
                  <input id={titleId + '-title-' + index} type="text" value={widget.title} maxLength={widgetTitleLimit}
                    placeholder={widgetTitle({ ...widget, title: '' })}
                    onInput={event => {
                      const title = event.currentTarget.value;
                      update(widget.id, current => ({ ...current, title }));
                    }} />
                </div>
              </div>
              <div class="dash-widget-actions">
                <button class="button button-small" type="button" disabled={index === 0}
                  aria-label={'Переместить виджет ' + (index + 1) + ' выше'} onClick={() => move(index, -1)}>↑ Выше</button>
                <button class="button button-small" type="button" disabled={index === draft.length - 1}
                  aria-label={'Переместить виджет ' + (index + 1) + ' ниже'} onClick={() => move(index, 1)}>↓ Ниже</button>
                <button class="button button-small" type="button" aria-label={'Удалить виджет ' + (index + 1)}
                  onClick={() => remove(index)}>Удалить</button>
              </div>
            </fieldset>
          </li>)}
        </ol> : <p class="dash-widget-empty">На вкладке пока нет виджетов.</p>}
        <div class="dash-widget-footer">
          <button class="button" type="button" onClick={() => dialog.current?.close()}>Отмена</button>
          <button class="button button-primary" type="submit" disabled={!ready}>Сохранить виджеты</button>
        </div>
      </form>
    </dialog>}
  </>;
}
