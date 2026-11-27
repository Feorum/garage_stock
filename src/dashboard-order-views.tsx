import { useRef, useState } from 'preact/hooks';
import { orderColumnIds, orderColumns, orderViewHref, type OrderColumn, type OrderLayout,
  type OrderTableSettings, type OrderView } from './dashboard-order-table';

type EditMode = 'create' | 'rename' | 'delete';

export function OrderViewControls({ settings, view, layout, ready, changeColumns, saveSettings }: {
  settings: OrderTableSettings;
  view: OrderView | undefined;
  layout: OrderLayout;
  ready: boolean;
  changeColumns: (columns: OrderColumn[]) => void;
  saveSettings: (settings: OrderTableSettings) => void;
}) {
  const [showColumns, setShowColumns] = useState(false);
  const [mode, setMode] = useState<EditMode | null>(null);
  const [name, setName] = useState('');
  const createButton = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLDivElement>(null);

  function startEdit(next: EditMode) {
    setName(next === 'rename' ? view?.name ?? '' : '');
    setMode(next);
    requestAnimationFrame(() => editor.current?.querySelector<HTMLElement>(next === 'delete' ? '.od-cancel' : 'input')?.focus());
  }

  function cancelEdit() {
    setMode(null);
    (mode === 'create' ? createButton : mode === 'rename' ? renameButton : deleteButton).current?.focus();
  }

  function applyEdit() {
    const title = name.trim();
    if (mode === 'create' && title) {
      const newView = { ...layout, id: crypto.randomUUID(), name: title };
      saveSettings({ ...settings, views: [...settings.views, newView] });
      location.hash = orderViewHref(newView.id);
    } else if (mode === 'rename' && title && view) {
      saveSettings({ ...settings, views: settings.views.map(item => item.id === view.id ? { ...item, name: title } : item) });
    } else if (mode === 'delete' && view) {
      saveSettings({ ...settings, views: settings.views.filter(item => item.id !== view.id) });
      location.hash = orderViewHref();
    }
    cancelEdit();
  }

  function moveColumn(from: number, to: number, event: MouseEvent) {
    const control = event.currentTarget as HTMLButtonElement;
    const input = control.closest('li')?.querySelector('input');
    const columns = [...layout.columns];
    [columns[from], columns[to]] = [columns[to], columns[from]];
    changeColumns(columns);
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== control) return;
      if (control.disabled) input?.focus();
      else control.focus();
    });
  }

  return <>
    <div class="od-views">
      <nav class="od-view-links" aria-label="Вкладки заказов">
        <a href={orderViewHref()} aria-current={view ? undefined : 'page'}>Основная</a>
        {settings.views.map(tab => <a key={tab.id} href={orderViewHref(tab.id)}
          aria-current={tab.id === view?.id ? 'page' : undefined}>{tab.name}</a>)}
      </nav>
      <div class="od-view-actions">
        <button type="button" ref={createButton} disabled={!ready} aria-expanded={mode === 'create'}
          onClick={() => mode === 'create' ? cancelEdit() : startEdit('create')}>Создать вкладку</button>
        <button type="button" disabled={!ready} aria-expanded={showColumns}
          aria-controls={showColumns ? 'od-column-settings' : undefined}
          onClick={() => {
            if (mode === 'rename' || mode === 'delete') setMode(null);
            setShowColumns(!showColumns);
          }}>Столбцы</button>
      </div>
    </div>
    <div ref={editor} class="od-view-editor" hidden={!mode}>
      {mode === 'delete' ? <>
        <p>Удалить вкладку «{view?.name}»?</p>
        <button type="button" class="od-delete" onClick={applyEdit}>Удалить вкладку</button>
        <button type="button" class="od-cancel" onClick={cancelEdit}>Отмена</button>
      </> : mode && <form onSubmit={event => { event.preventDefault(); applyEdit(); }}>
        <label>Название вкладки <input value={name} required maxLength={60}
          onInput={event => setName(event.currentTarget.value)} /></label>
        <button type="submit" disabled={!name.trim()}>{mode === 'create' ? 'Создать' : 'Сохранить'}</button>
        <button type="button" class="od-cancel" onClick={cancelEdit}>Отмена</button>
      </form>}
    </div>
    {showColumns && <div class="od-column-settings" id="od-column-settings">
      {view && <div class="od-tab-edit">
        <button type="button" ref={renameButton} onClick={() => startEdit('rename')}>Переименовать вкладку</button>
        <button type="button" ref={deleteButton} onClick={() => startEdit('delete')}>Удалить вкладку</button>
      </div>}
      <ul aria-label="Столбцы таблицы">
        {[...layout.columns, ...orderColumnIds.filter(column => !layout.columns.includes(column))].map((column, index) => {
          const shown = index < layout.columns.length;
          const label = orderColumns[column].label;
          return <li key={column}>
            <label>
              <input type="checkbox" checked={shown} disabled={shown && layout.columns.length === 1}
                aria-label={'Показывать столбец «' + label + '»'}
                onChange={event => {
                  const checkbox = event.currentTarget;
                  changeColumns(checkbox.checked ? [...layout.columns, column] : layout.columns.filter(item => item !== column));
                  requestAnimationFrame(() => {
                    if (document.activeElement === document.body) checkbox.focus();
                  });
                }} />
              {label}
            </label>
            {shown && <span class="od-move-column">
              <button type="button" aria-label={label + ' · переместить вверх'} title="Переместить вверх"
                disabled={index === 0} onClick={event => moveColumn(index, index - 1, event)}>↑</button>
              <button type="button" aria-label={label + ' · переместить вниз'} title="Переместить вниз"
                disabled={index === layout.columns.length - 1} onClick={event => moveColumn(index, index + 1, event)}>↓</button>
            </span>}
          </li>;
        })}
      </ul>
    </div>}
  </>;
}
