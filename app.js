import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// 1) Paste your own values from Supabase -> Project Settings -> API
//    The anon key is meant to be public. Security comes from the Row Level Security rules in schema.sql.
//    NEVER put the service_role key here.
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');

// ---------- tiny helpers ----------
// el() builds DOM nodes with textContent, so user input can never inject HTML.
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n[k] = v;
  }
  n.append(...kids.flat().filter(x => x != null));
  return n;
};
const eur = n => '€' + Number(n || 0).toLocaleString('en-US');
const fmtDate = d => d.split('-').reverse().join('.');
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
const show = (...nodes) => app.replaceChildren(...nodes);
const signOut = async () => { await sb.auth.signOut(); loginView(); };
const header = title => el('div', { class: 'top' }, el('h1', {}, title),
  el('button', { onclick: signOut }, 'Sign out'));
const fail = e => show(header('Error'), el('div', { class: 'card msg' }, e.message || String(e)));

let profile = null, works = [];

// ---------- login ----------
function loginView() {
  const email = el('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' });
  const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const msg = el('div', { class: 'msg' });
  const go = async () => {
    msg.textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) msg.textContent = error.message; else boot();
  };
  show(el('h1', {}, 'Garage Daily Log'), el('p', { class: 'sub' }, 'Sign in with the account your administrator gave you.'),
    el('div', { class: 'card' }, email, pass, el('button', { class: 'p', onclick: go }, 'Sign in'), msg));
}

async function boot() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return loginView();
  const p = await sb.from('profiles').select('name,role').eq('id', user.id).single();
  if (p.error) return fail(p.error);
  profile = p.data;
  const w = await sb.from('works').select('id,name').eq('active', true).order('sort').order('id');
  if (w.error) return fail(w.error);
  works = w.data;
  profile.role === 'admin' ? adminView() : mechanicView();
}

// ---------- mechanic ----------
async function mechanicView() {
  const day = today();
  const draft = { car: '', ids: new Set() };

  async function draw() {
    const { data: rows, error } = await sb.from('jobs').select('id,car,works(name)')
      .eq('job_date', day).order('id');           // RLS: only my own rows come back
    if (error) return fail(error);

    const byCar = new Map();
    rows.forEach(r => { if (!byCar.has(r.car)) byCar.set(r.car, []); byCar.get(r.car).push(r); });
    const saved = [...byCar].map(([car, items]) => el('div', { class: 'card' },
      el('div', { class: 'row' }, el('b', { class: 'grow' }, car),
        el('button', { class: 'd', onclick: async () => {
          const { error } = await sb.from('jobs').delete().in('id', items.map(i => i.id));
          error ? fail(error) : draw();
        } }, '✕')),
      items.map(i => el('div', { class: 'line' }, i.works.name))));

    const msg = el('div', { class: 'msg' });
    const carInput = el('input', { placeholder: 'Car (model / plate)', value: draft.car,
      oninput: e => { draft.car = e.target.value; } });
    const chips = el('div', { class: 'chips' }, works.map(w => {
      const b = el('button', { class: 'chip' + (draft.ids.has(w.id) ? ' on' : '') }, w.name);
      b.onclick = () => { draft.ids.has(w.id) ? draft.ids.delete(w.id) : draft.ids.add(w.id);
        b.className = 'chip' + (draft.ids.has(w.id) ? ' on' : ''); };
      return b;
    }));
    const save = async () => {
      if (!draft.car.trim() || !draft.ids.size) { msg.textContent = 'Enter the car and pick at least one job.'; return; }
      const { error } = await sb.from('jobs').insert([...draft.ids].map(work_id =>
        ({ car: draft.car.trim(), work_id, job_date: day })));
      if (error) { msg.textContent = error.message; return; }
      draft.car = ''; draft.ids.clear(); draw();
    };

    show(header('Hello, ' + profile.name), el('div', { class: 'sub' }, 'Work log for ' + fmtDate(day) +
      ' · saved entries go straight to the administrator'),
      el('div', { class: 'card' }, el('h2', {}, 'Add a car'), carInput, chips,
        el('button', { class: 'p', onclick: save }, 'Save car'), msg),
      el('h2', {}, 'Saved today (' + byCar.size + ' cars)'), saved);
  }
  draw();
}

// ---------- admin ----------
function adminView(tab = 'report', date = today()) {
  const box = el('div');
  const tabs = el('div', { class: 'tabs' },
    el('button', { class: tab === 'report' ? 'on' : '', onclick: () => adminView('report', date) }, 'Daily reports'),
    el('button', { class: tab === 'prices' ? 'on' : '', onclick: () => adminView('prices', date) }, 'Works & prices'));
  show(header('Administrator'), tabs, box);
  tab === 'report' ? reportTab(box, date) : pricesTab(box);
}

async function reportTab(box, date) {
  const dt = el('input', { type: 'date', value: date, onchange: e => adminView('report', e.target.value || today()) });
  const { data, error } = await sb.rpc('admin_report', { d: date });
  if (error) return box.replaceChildren(el('div', { class: 'card msg' }, error.message));

  const mech = new Map();
  data.forEach(r => {
    if (!mech.has(r.mechanic)) mech.set(r.mechanic, new Map());
    const cars = mech.get(r.mechanic);
    if (!cars.has(r.car)) cars.set(r.car, []);
    cars.get(r.car).push(r);
  });
  let grand = 0;
  const cards = [...mech].map(([name, cars]) => {
    const sum = [...cars.values()].flat().reduce((s, r) => s + Number(r.price), 0);
    grand += sum;
    return el('div', { class: 'card' }, el('div', { class: 'line tot' }, el('span', {}, name), el('span', {}, eur(sum))),
      [...cars].map(([car, items]) => el('div', { style: 'margin-top:8px' }, el('b', {}, car),
        items.map(i => el('div', { class: 'line' }, el('span', {}, i.work), el('span', {}, eur(i.price)))))));
  });
  const csv = () => {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = ['Date,Mechanic,Car,Work,Price EUR', ...data.map(r => [date, r.mechanic, r.car, r.work, r.price].map(q).join(','))];
    const a = el('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: `garage_${date}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  box.replaceChildren(el('div', { class: 'card' }, dt),
    cards.length ? cards : el('div', { class: 'card mut' }, 'No work recorded on ' + fmtDate(date) + '.'),
    el('div', { class: 'card line tot' }, el('span', {}, 'Total ' + fmtDate(date)), el('span', {}, eur(grand))),
    el('button', { class: 'p', onclick: csv }, 'Download day as CSV'));
}

async function pricesTab(box) {
  const { data, error } = await sb.from('works').select('id,name,work_prices(price)')
    .eq('active', true).order('sort').order('id');
  if (error) return box.replaceChildren(el('div', { class: 'card msg' }, error.message));
  const msg = el('div', { class: 'msg' });
  const rows = data.map(w => el('div', { class: 'row', style: 'margin-bottom:8px' },
    el('div', { class: 'grow' }, w.name),
    el('input', { class: 'price', type: 'number', inputMode: 'decimal', min: 0, step: '0.01', style: 'margin:0',
      value: w.work_prices ? w.work_prices.price : '',
      onchange: async e => {
        const { error } = await sb.from('work_prices').upsert({ work_id: w.id, price: Number(e.target.value) || 0 });
        msg.textContent = error ? error.message : '';
      } }),
    el('button', { class: 'd', title: 'Hide this work', onclick: async () => {
      await sb.from('works').update({ active: false }).eq('id', w.id); pricesTab(box);
    } }, '✕')));
  const nm = el('input', { placeholder: 'New work name' });
  const np = el('input', { type: 'number', inputMode: 'decimal', placeholder: 'Price €' });
  const add = async () => {
    if (!nm.value.trim()) return;
    const w = await sb.from('works').insert({ name: nm.value.trim() }).select('id').single();
    if (w.error) { msg.textContent = w.error.message; return; }
    await sb.from('work_prices').insert({ work_id: w.data.id, price: Number(np.value) || 0 });
    pricesTab(box);
  };
  box.replaceChildren(el('div', { class: 'card' }, el('h2', {}, 'Works & prices'),
    el('p', { class: 'sub' }, 'Mechanics see only the work names, never the prices.'), rows, msg),
    el('div', { class: 'card' }, el('h2', {}, 'Add work'), nm, np, el('button', { class: 'p', onclick: add }, 'Add')));
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
