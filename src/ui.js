export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'required'].includes(key)) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter(child => child != null));
  return node;
}

const PATHS = {
  orders: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  assigned: 'M9 5H5v16h14V5h-4 M9 3h6v4H9z M8 13l2 2 5-5',
  catalogue: 'M4 4h16v16H4z M8 4v16 M11 9h6 M11 13h6 M11 17h4',
  reports: 'M4 4v16h16 M8 16v-4 M12 16V8 M16 16V5',
  work: 'M8 4h8l1 4h4v12H3V8h4l1-4z M3 12h18 M10 12v3h4v-3'
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] || PATHS.orders);
  svg.append(path);
  return svg;
}

export function renderNotice(title, description, type = 'info') {
  return element('div', { class: `notice notice-${type}`, role: type === 'error' ? 'alert' : 'status' },
    element('strong', {}, title), element('p', {}, description));
}
