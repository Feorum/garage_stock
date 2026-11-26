import { GiftDialog, qualifies, type GiftOffer } from './owner-gift';
import { useCallback, useEffect, useState, useRef } from 'preact/hooks';
import { WORKS, VEHICLE_GROUPS } from './catalogue.js';
import { findVehicleChoice, orderVehicleChoices, requiresOkavangoYear } from './vehicle-models';
import type { GarageClient } from './shift-model';
import {
  availableWorks,
  errorText,
  fieldLabel,
  hood,
  initialDraft,
  isConflict,
  protectedTask,
  workName,
  type Choice,
  type Draft,
  type EditorSeed,
  type Mutate,
  type Money,
  type OrderFields,
  type Staff,
} from './owner-model';
import { Quote, SourceReference } from './owner-summary';

interface EditorProps {
  seed: EditorSeed;
  offer: GiftOffer | null;
  giftError: boolean;
  client: GarageClient;
  staff: Staff[];
  mutate: Mutate;
  reload: () => Promise<EditorSeed | null>;
  close: () => void;
  saved: (id: string, message: string) => Promise<void>;
  quoteRevision?: string;
}
type ConflictRow = { key: string; title: string; mine: string; latest: string; choose: boolean };
function compareDraft(
  base: Draft,
  mine: Draft,
  remote: Draft,
  seed: EditorSeed,
  takeMine: Record<string, boolean>,
) {
  const result: Draft = structuredClone(remote);
  const changes: ConflictRow[] = [];
  for (const key of Object.keys(fieldLabel) as (keyof OrderFields)[]) {
    const localChanged = mine.fields[key] !== base.fields[key];
    const savedChanged = remote.fields[key] !== base.fields[key];
    const locked = key === 'vehicle_group_code' && seed.order?.tasks.some(protectedTask);
    const choose = Boolean(!locked && localChanged && savedChanged);
    if (mine.fields[key] !== remote.fields[key]) {
      changes.push({
        key,
        title: fieldLabel[key],
        mine: mine.fields[key],
        latest: remote.fields[key],
        choose,
      });
    }
    if (!localChanged || locked || (choose && !takeMine[key])) continue;
    result.fields[key] = mine.fields[key];
  }
  const codes = new Set([...base.choices, ...mine.choices, ...remote.choices].map((c) => c.work_code));
  const describe = (c: Choice | undefined) =>
    c
      ? [workName(c.work_code), c.options.tint_percent ? c.options.tint_percent + '%' : '', c.instructions]
          .filter(Boolean)
          .join(' · ')
      : 'Работа исключена';
  const equal = (a: Choice | undefined, b: Choice | undefined) => JSON.stringify(a) === JSON.stringify(b);
  for (const code of codes) {
    const previous = base.choices.find((c) => c.work_code === code),
      local = mine.choices.find((c) => c.work_code === code),
      latest = remote.choices.find((c) => c.work_code === code);
    const key = 'work-' + code;
    const localChanged = !equal(previous, local);
    const locked = seed.order?.tasks.some((t) => t.work_code === code && protectedTask(t));
    const choose = Boolean(!locked && localChanged && !equal(previous, latest));
    if (!equal(latest, local)) {
      changes.push({ key, title: workName(code), mine: describe(local), latest: describe(latest), choose });
    }
    if (!localChanged || locked || (choose && !takeMine[key])) continue;
    result.choices = result.choices.filter((c) => c.work_code !== code);
    if (local && availableWorks(result.fields.vehicle_group_code).includes(code)) {
      const choice = { ...local, id: latest?.id };
      if (latest?.id) {
        choice.mechanic_ids = latest.mechanic_ids;
        choice.assigned_to = latest.assigned_to;
      }
      result.choices.push(choice);
    }
  }
  return { result, changes };
}
export function OrderEditor({
  seed,
  client,
  staff,
  mutate,
  close,
  reload,
  saved,
  offer,
  giftError,
  quoteRevision,
}: EditorProps) {
  const [base, setBase] = useState(seed);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(seed));
  const [defaultWorker, setDefaultWorker] = useState('');
  const [pending, setPending] = useState(false),
    busy = useRef(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState<EditorSeed | null>(null);
  const [stale, setStale] = useState(false);
  const [takeMine, setTakeMine] = useState<Record<string, boolean>>({});
  const resolving = base.mode === 'intake',
    editing = base.mode === 'edit';
  const fixed = (base.order?.tasks || []).filter(protectedTask);
  const selectedModel = orderVehicleChoices.find(model => model.label === draft.fields.vehicle
    && model.group === draft.fields.vehicle_group_code);
  const [manualVehicle, setManualVehicle] = useState(false);
  const showManualVehicle = !selectedModel && (manualVehicle || Boolean(draft.fields.vehicle));
  const mandatory = draft.fields.source === 'owner';
  const ambiguous = resolving && (base.intake?.row_numbers?.length || 0) > 1;
  const options = availableWorks(draft.fields.vehicle_group_code);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gift, setGift] = useState<{ code: string; added: boolean } | null>(null);
  const touchedWork = useRef(false);
  const wasEligible = useRef(false);
  const requestedGift = useRef(Boolean(seed.promptGift));
  const quote = useRef<Money | null>(null);
  const acceptQuote = useCallback((value: Money | null) => {
    quote.current = value;
  }, []);
  const eligible = qualifies(
    offer,
    draft.fields.vehicle_group_code,
    draft.choices.map((c) => c.work_code),
  );
  useEffect(() => {
    if (eligible && !wasEligible.current && (requestedGift.current || !editing || touchedWork.current)) {
      setDialogOpen(true);
      requestedGift.current = false;
    }
    wasEligible.current = eligible;
    if (!eligible) {
      setDialogOpen(false);
      if (gift) {
        if (gift.added)
          setDraft((d) => ({ ...d, choices: d.choices.filter((c) => c.work_code !== gift.code) }));
        setGift(null);
        setMessage('Состав заказа изменился. Предложение подарка снято.');
      }
    }
  }, [eligible, editing, gift]);
  function chooseGift(accept: boolean) {
    setDialogOpen(false);
    if (!accept || !eligible || !offer) return;
    const code = offer.work_code;
    const found = draft.choices.some((c) => c.work_code === code);
    if (!found) toggleWork(code, true);
    setGift({ code, added: !found });
  }
  function undoGift() {
    if (gift?.added) toggleWork(gift.code, false);
    setGift(null);
  }
  function field(key: keyof OrderFields, value: string) {
    setMessage('');
    setDraft((d) => {
      const fields = { ...d.fields, [key]: value };
      let choices = d.choices;
      if (key === 'vehicle_group_code')
        choices = choices.filter((c) => availableWorks(value).includes(c.work_code));
      if (key === 'source')
        choices = choices.map((c) => ({
          ...c,
          assigned_to: value === 'owner' && defaultWorker ? defaultWorker : null,
          mechanic_ids: value === 'owner' && defaultWorker ? [defaultWorker] : [],
        }));
      return { fields, choices };
    });
  }
  function chooseModel(label: string) {
    const model = orderVehicleChoices.find(choice => choice.label === label);
    setManualVehicle(!model);
    setMessage('');
    setDraft(d => {
      const group = model?.group || d.fields.vehicle_group_code;
      return { fields: { ...d.fields, vehicle: model?.label || '', vehicle_group_code: group },
        choices: d.choices.filter(choice => availableWorks(group).includes(choice.work_code)) };
    });
  }
  function changeChoice(code: string, update: Partial<Choice>) {
    setDraft((d) => ({
      ...d,
      choices: d.choices.map((c) => (c.work_code === code ? { ...c, ...update } : c)),
    }));
  }
  function toggleWork(code: string, checked: boolean) {
    setMessage('');
    touchedWork.current = true;
    if (!checked && gift?.code === code) setGift(null);
    setDraft((d) => {
      let choices = d.choices.filter(
        (c) => c.work_code !== code && !(checked && hood.has(code) && hood.has(c.work_code)),
      );
      if (checked) {
        const previous = initialDraft(base).choices.find((c) => c.work_code === code);
        choices.push(
          previous || {
            work_code: code,
            options: {},
            instructions: '',
            assigned_to: mandatory && defaultWorker ? defaultWorker : null,
            mechanic_ids: mandatory && defaultWorker ? [defaultWorker] : [],
          },
        );
      }
      choices.sort((a, b) => a.work_code.localeCompare(b.work_code));
      return { ...d, choices };
    });
  }
  async function loadConflict() {
    try {
      const current = await reload();
      if (!current) {
        setMessage('Запись больше недоступна для изменения. Закройте форму после проверки введённых данных.');
        return;
      }
      setConflict(current);
      setTakeMine({});
      setMessage('');
    } catch {
      setMessage('Не удалось загрузить актуальную версию. Ваши данные сохранены в форме.');
    }
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy.current || stale || ambiguous) return;
    const recognized = findVehicleChoice(draft.fields.vehicle, orderVehicleChoices);
    const originalVehicle = editing && base.order?.vehicle === draft.fields.vehicle
      && base.order?.vehicle_group_code === draft.fields.vehicle_group_code;
    if (!originalVehicle && !recognized && requiresOkavangoYear(draft.fields.vehicle)) {
      setMessage('Укажите год OKAVANGO из актуального прайса. Для этого года ценовая группа ещё не выбрана.');
      return;
    }
    if (!originalVehicle && recognized && recognized.group !== draft.fields.vehicle_group_code) {
      setMessage('Для выбранной модели укажите соответствующую группу прайса или выберите модель из списка.');
      return;
    }
    const missing = draft.choices.find((c) => mandatory && !c.mechanic_ids.length);
    if (!draft.fields.vehicle.trim() || !draft.choices.length || missing) {
      setMessage(
        !draft.fields.vehicle.trim()
          ? 'Укажите автомобиль.'
          : !draft.choices.length
            ? 'Выберите хотя бы одну доступную работу.'
            : 'Назначьте механика для работы «' + workName(missing!.work_code) + '».',
      );
      requestAnimationFrame(() =>
        document
          .getElementById(
            !draft.fields.vehicle.trim()
              ? 'new-vehicle'
              : missing
                ? 'team-' + missing.work_code
                : 'work-legend',
          )
          ?.focus(),
      );
      return;
    }
    busy.current = true;
    setPending(true);
    setMessage('');
    try {
      const selectedGift =
        eligible && gift ? draft.choices.find((c) => c.work_code === gift.code) : undefined;
      let giftVersion = 0;
      if (selectedGift?.id) {
        const current = quote.current?.items?.find((item) => item.task_id === selectedGift.id);
        if (current?.private_version == null) {
          setMessage('Дождитесь актуального расчёта цены подарка и повторите сохранение.');
          return;
        }
        giftVersion = current.private_version;
      }
      const result = await mutate<{ order_id: string }>(
        selectedGift ? 'garage_save_order_with_gift' : 'garage_save_team_order',
        {
          ...(selectedGift ? { p_gift_expected_version: giftVersion } : {}),
          p_mode: base.mode,
          p_id: base.order?.id || base.intake?.id || null,
          p_expected_version: base.order?.version || base.intake?.version || null,
          p_order: {
            ...draft.fields,
            vehicle: !originalVehicle && recognized ? recognized.label : draft.fields.vehicle,
            planned_date: draft.fields.planned_date || null,
            due_date: draft.fields.due_date || null,
            manager_label: mandatory ? '' : draft.fields.manager_label,
          },
          p_tasks: draft.choices.map((c) => (mandatory ? c : { ...c, assigned_to: null, mechanic_ids: [] })),
        },
      );
      await saved(
        result.order_id,
        editing
          ? 'Заказ обновлён. Выбранные работы сохранятся при последующих изменениях таблицы.'
          : resolving
            ? 'Выбранные работы опубликованы в общей очереди менеджеров.'
            : mandatory
              ? 'Заказ отправлен назначенной команде.'
              : 'Заказ опубликован в общей очереди менеджеров.',
      );
    } catch (error) {
      if (isConflict(error) && base.mode !== 'new') {
        setStale(true);
        await loadConflict();
      } else setMessage(errorText(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const merged = conflict
    ? compareDraft(initialDraft(base), draft, initialDraft(conflict), conflict, takeMine)
    : null;
  const textInput = (key: keyof OrderFields, label: string, max: number, required = false) => (
    <label>
      {label}
      <input
        id={'new-' + key}
        name={key}
        maxLength={max}
        required={required}
        value={draft.fields[key]}
        onInput={(e) => field(key, e.currentTarget.value)}
      />
    </label>
  );
  return (
    <form
      class="new-order-form"
      onSubmit={submit}
      aria-label={resolving ? 'Проверка заявки менеджера' : editing ? 'Изменение заказа' : 'Новый заказ'}
    >
      <fieldset disabled={pending} class="order-form-fields">
        <legend>
          {resolving
            ? 'Проверка заявки менеджера'
            : editing
              ? 'Изменение заказа'
              : 'Новый заказ'}
        </legend>
        {resolving && <SourceReference intake={base.intake} />}
        {ambiguous && (
          <p role="status" class="notice">
            Перед публикацией разделите повторяющиеся строки в рабочей таблице и обновите заявку.
          </p>
        )}
        <fieldset>
          <legend>Автомобиль и сроки</legend>
          <div class="form-grid">
            <label>
              Модель автомобиля
              <select id="order-vehicle-model" value={selectedModel?.label || (manualVehicle || draft.fields.vehicle ? 'manual' : '')}
                required onChange={e => chooseModel(e.currentTarget.value)}>
                <option value="" disabled>Выберите модель</option>
                {orderVehicleChoices.filter(model => !fixed.length || model.group === base.order?.vehicle_group_code)
                  .map(model => <option key={model.label} value={model.label}>{model.label}</option>)}
                <option value="manual">Другой автомобиль — указать вручную</option>
              </select>
            </label>
            {showManualVehicle && textInput('vehicle', 'Автомобиль', 200, true)}
            {showManualVehicle && <label>
              Группа автомобилей
              <select
                id="new-group"
                name="vehicle_group_code"
                required
                disabled={fixed.length > 0}
                value={draft.fields.vehicle_group_code}
                onChange={(e) => field('vehicle_group_code', e.currentTarget.value)}
              >
                <option value="">Выберите группу автомобилей</option>
                {VEHICLE_GROUPS.map((g) => (
                  <option key={g.code} value={g.code}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>}
            {textInput('vin', resolving ? 'VIN' : 'VIN (необязательно)', 40, resolving)}
            {textInput('colour', 'Цвет (необязательно)', 80)}
            <label>
              Источник заказа
              <select
                id="new-source"
                disabled={base.mode !== 'new'}
                value={draft.fields.source}
                onChange={(e) => field('source', e.currentTarget.value)}
              >
                <option value="owner">Назначение владельца</option>
                <option value="manager">Общая очередь менеджеров</option>
              </select>
            </label>
            {!mandatory &&
              textInput('manager_label', resolving ? 'Менеджер' : 'Менеджер (необязательно)', 120, resolving)}
            <label>
              {resolving ? 'Плановая дата' : 'Плановая дата (необязательно)'}
              <input
                type="date"
                required={resolving}
                value={draft.fields.planned_date}
                onInput={(e) => field('planned_date', e.currentTarget.value)}
              />
            </label>
            <label>
              Срок выполнения (необязательно)
              <input
                type="date"
                value={draft.fields.due_date}
                onInput={(e) => field('due_date', e.currentTarget.value)}
              />
            </label>
            <label>
              Приоритет
              <select
                value={draft.fields.priority}
                onChange={(e) => field('priority', e.currentTarget.value)}
              >
                <option value="normal">Обычный</option>
                <option value="high">Высокий</option>
                <option value="urgent">Срочный</option>
              </select>
            </label>
          </div>
        </fieldset>
        <fieldset class="ordered-works">
          <legend id="work-legend" tabIndex={-1}>
            Работы и исполнители
          </legend>
          {mandatory && (
            <label>
              Назначить механика
              <select
                id="new-assigned"
                value={defaultWorker}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  setDefaultWorker(id);
                  if (id)
                    setDraft((d) => ({
                      ...d,
                      choices: d.choices.map((c) =>
                        c.id || c.mechanic_ids.length ? c : { ...c, assigned_to: id, mechanic_ids: [id] },
                      ),
                    }));
                }}
              >
                <option value="">Выбрать для новых работ</option>
                {staff.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div class="work-choices">
            {WORKS.map((w) => {
              const choice = draft.choices.find((c) => c.work_code === w.code);
              const retained = fixed.some((t) => t.work_code === w.code);
              return (
                <div key={w.code} class="work-choice-item">
                  <label class="work-choice">
                    <input
                      id={'new-work-' + w.code}
                      type="checkbox"
                      value={w.code}
                      checked={Boolean(choice)}
                      disabled={
                        !options.includes(w.code) ||
                        retained ||
                        (hood.has(w.code) &&
                          fixed.some((t) => t.work_code !== w.code && hood.has(t.work_code || '')))
                      }
                      onChange={(e) => toggleWork(w.code, e.currentTarget.checked)}
                    />
                    {w.name}
                  </label>
                  {choice && mandatory && (
                    <fieldset id={'team-' + w.code} tabIndex={-1} class="team-picker">
                      <legend>Исполнители · {w.name}</legend>
                      {choice.id ? (
                        <p>
                          {choice.mechanic_ids
                            .map(
                              (id) =>
                                staff.find((s) => s.id === id)?.name ||
                                base.order?.tasks
                                  .flatMap((t) => t.participants || [])
                                  .find((p) => p.mechanic_id === id)?.name ||
                                'Механик',
                            )
                            .join(', ')}{' '}
                          · Состав меняется в разделе «Цены и выплаты».
                        </p>
                      ) : (
                        staff.map((person) => (
                          <label class="work-choice" key={person.id}>
                            <input
                              type="checkbox"
                              checked={choice.mechanic_ids.includes(person.id)}
                              onChange={(e) => {
                                const next = e.currentTarget.checked
                                  ? [...choice.mechanic_ids, person.id]
                                  : choice.mechanic_ids.filter((id) => id !== person.id);
                                changeChoice(w.code, { mechanic_ids: next, assigned_to: next[0] || null });
                              }}
                            />
                            {person.name}
                          </label>
                        ))
                      )}
                    </fieldset>
                  )}
                </div>
              );
            })}
          </div>
          {draft.choices.some((c) => c.work_code === 'W19') && (
            <label>
              Светопропускание
              <select
                required
                disabled={fixed.some((t) => t.work_code === 'W19')}
                value={String(draft.choices.find((c) => c.work_code === 'W19')?.options.tint_percent || '')}
                onChange={(e) =>
                  changeChoice('W19', { options: { tint_percent: Number(e.currentTarget.value) } })
                }
              >
                <option value="">Выберите светопропускание</option>
                <option value="5">5%</option>
                <option value="15">15%</option>
              </select>
            </label>
          )}
        </fieldset>
        <fieldset>
          <legend>Проверка и отправка</legend>
          <label>
            Указания (необязательно)
            <textarea
              rows={3}
              maxLength={4000}
              value={draft.fields.instructions}
              onInput={(e) => field('instructions', e.currentTarget.value)}
            />
          </label>
          {giftError && <p role="status">Не удалось проверить предложения для этого заказа.</p>}
          {eligible &&
            offer &&
            (gift ? (
              <div class="gift-selection">
                <p>Подарок клиенту · {workName(gift.code)}</p>
                <button type="button" class="button" onClick={undoGift}>
                  Отменить подарок
                </button>
              </div>
            ) : (
              <button type="button" class="button" onClick={() => setDialogOpen(true)}>
                Выбрать подарок
              </button>
            ))}
          {dialogOpen && eligible && offer && <GiftDialog offer={offer} choose={chooseGift} />}
          <Quote
            key={quoteRevision}
            giftCode={eligible && gift ? gift.code : undefined}
            onQuote={acceptQuote}
            client={client}
            group={draft.fields.vehicle_group_code}
            choices={draft.choices}
            orderId={base.order?.id}
          />
        </fieldset>
        {stale && (
          <section class="notice ledger-conflict" aria-live="polite">
            <strong>Заказ изменился. Проверьте актуальную версию</strong>
            {conflict && merged ? (
              <>
                <p>
                  Правки сохранены. Сравните отличия перед повторным сохранением. Начатые работы останутся в
                  актуальном составе.
                </p>
                {merged.changes.map((c) =>
                  !c.choose ? (
                    <div key={c.key}>
                      <strong>{c.title}</strong>
                      <p>
                        Ваш ввод: {c.mine || '—'} · Сохранённое: {c.latest || '—'}
                      </p>
                    </div>
                  ) : (
                    <label key={c.key}>
                      {c.title}
                      <select
                        value={takeMine[c.key] ? 'mine' : 'remote'}
                        onChange={(e) =>
                          setTakeMine((old) => ({ ...old, [c.key]: e.currentTarget.value === 'mine' }))
                        }
                      >
                        <option value="remote">Сохранённое: {c.latest || '—'}</option>
                        <option value="mine">Ваш ввод: {c.mine || '—'}</option>
                      </select>
                    </label>
                  ),
                )}
                <button
                  type="button"
                  class="button"
                  onClick={() => {
                    setGift(null);
                    setBase(conflict);
                    setDraft(merged.result);
                    setConflict(null);
                    setStale(false);
                  }}
                >
                  Применить к актуальной версии
                </button>
              </>
            ) : (
              <button type="button" class="button" onClick={loadConflict}>
                Повторить загрузку
              </button>
            )}
          </section>
        )}
        {message && (
          <p class="form-feedback" role="alert">
            {message}
          </p>
        )}
        <div class="button-row">
          <button class="button button-primary" disabled={stale || pending || ambiguous} type="submit">
            {resolving ? 'Опубликовать заказ' : editing ? 'Сохранить изменения' : 'Отправить заказ'}
          </button>
          <button class="button" type="button" onClick={close}>
            Закрыть форму
          </button>
        </div>
      </fieldset>
    </form>
  );
}
