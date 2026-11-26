const labels = {
  overview: 'Обзор', prices: 'Цены', payroll: 'Оплата механиков', edit: 'Изменить заказ',
  create: 'Данные заказа', photos: 'Фото', documents: 'Документы',
};
export type OrderSection = keyof typeof labels;

export function OrderSectionBar({ sections, selected, change }: {
  sections: OrderSection[]; selected: OrderSection; change: (key: OrderSection) => void;
}) {
  return <div class="order-section-bar" role="group" aria-label="Разделы заказа">
    {sections.map(key => <button type="button" key={key} aria-pressed={selected === key}
      onClick={() => change(key)}>{labels[key]}</button>)}
  </div>;
}

export function PhotoShortcut({ open }: { open: () => void }) {
  return <button type="button" class="order-photo-shortcut" onClick={open}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
      <path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="3.25"/>
    </svg>Фото к заказу
  </button>;
}
