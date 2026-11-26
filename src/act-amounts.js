const units = ['','один','два','три','четыре','пять','шесть','семь','восемь','девять'];
const teens = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
const tens = ['','','двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
const hundreds = ['','сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];
const scales = [
  ['', '', ''],
  ['тысяча', 'тысячи', 'тысяч'],
  ['миллион', 'миллиона', 'миллионов'],
  ['миллиард', 'миллиарда', 'миллиардов'],
  ['триллион', 'триллиона', 'триллионов'],
];
const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function form(value, words) {
  const last = value % 10;
  if (value % 100 >= 11 && value % 100 <= 14) return words[2];
  if (last === 1) return words[0];
  return words[last >= 2 && last <= 4 ? 1 : 2];
}

function rublesInWords(value) {
  if (value === 0) return 'ноль';
  const groups = [];
  for (let scale = 0; value > 0; ++scale, value = Math.floor(value / 1000)) {
    const n = value % 1000;
    if (!n) continue;
    const last = n % 10;
    const words = [hundreds[Math.floor(n / 100)]];
    if (n % 100 >= 10 && n % 100 < 20) words.push(teens[n % 100 - 10]);
    else {
      words.push(tens[Math.floor(n % 100 / 10)]);
      words.push(scale === 1 && last === 1 ? 'одна' : scale === 1 && last === 2 ? 'две' : units[last]);
    }
    if (scale) words.push(form(n, scales[scale]));
    groups.unshift(words.filter(Boolean).join(' '));
  }
  return groups.join(' ');
}

/** @param {number} kopeks */
export function validActAmount(kopeks) {
  if (!Number.isSafeInteger(kopeks) || kopeks < 0) throw new Error('Для каждой работы нужна точная цена в BYN.');
  return kopeks;
}

/** @param {number} kopeks */
export function actPrice(kopeks) {
  validActAmount(kopeks);
  return Math.floor(kopeks / 100) + ',' + String(kopeks % 100).padStart(2, '0');
}

/**
 * Keep the original order within each service group and the individual prices
 * behind a grouped subtotal. W19 is the catalogue code for window tinting.
 * @param {{ name: string, workCode?: string, kopeks: number | null }[]} jobs
 * @param {boolean} showPrices
 */
export function actWorkLines(jobs, showPrices) {
  const other = jobs.filter(job => job.workCode !== 'W19');
  const tint = jobs.filter(job => job.workCode === 'W19');
  return [other, tint].filter(group => group.length > 0).map((group, index) => {
    const name = group.map(job => {
      const detail = group.length > 1 && showPrices && job.kopeks !== null
        ? ' (' + actPrice(job.kopeks) + ' BYN)' : '';
      return job.name.trim() + detail;
    }).join(', ');
    const kopeks = showPrices && group.every(job => job.kopeks !== null)
      ? group.reduce((sum, job) => validActAmount(sum + validActAmount(Number(job.kopeks))), 0)
      : null;
    return { label: (index + 1) + '. ' + name, kopeks };
  });
}

/** @param {number} kopeks */
export function actTotal(kopeks) {
  validActAmount(kopeks);
  const rubles = Math.floor(kopeks / 100);
  const cents = kopeks % 100;
  return rubles + ' (' + rublesInWords(rubles) + ') ' +
    form(rubles, ['белорусский рубль', 'белорусских рубля', 'белорусских рублей']) + ', ' +
    String(cents).padStart(2, '0') + ' ' + form(cents, ['копейка', 'копейки', 'копеек']);
}

/** @param {string} iso @param {'г.' | 'года'} suffix */
export function actDateLabel(iso, suffix) {
  const [year, month, day] = iso.split('-');
  const date = new Date(iso + 'T00:00:00.000Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || year === '0000' || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== iso) throw new Error('Проверьте дату акта и дату договора.');
  return '«' + day + '» ' + months[Number(month) - 1] + ' ' + year + ' ' + suffix;
}
