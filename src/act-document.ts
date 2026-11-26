import JSZip from 'jszip';
import { actDateLabel, actPrice, actTotal, validActAmount } from './act-amounts.js';

export interface ActDocumentData {
  number: string;
  contractNumber: string;
  contractDate: string;
  actDate: string;
  vehicle: string;
  vin: string;
  jobs: { name: string; kopeks: number | null }[];
  mode?: 'weighted' | 'discount' | 'names';
  agreedTotal?: number | null;
}

const documentPath = 'word/document.xml';
const start = '<?garage-jobs-start?>';
const end = '<?garage-jobs-end?>';
const token = /\{\{GARAGE_([A-Z_]+)\}\}/g;
const invalidTemplate = () => new Error('Форма акта повреждена. Проверьте шаблон.');

function xmlText(value: string): string {
  value = value.trim();
  if (!value || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value))
    throw new Error('Проверьте обязательные поля акта.');
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function replaceSlots(xml: string, fields: Record<string, string>): string {
  const remaining = new Set(Object.keys(fields));
  const filled = xml.replace(token, (_whole, key: string) => {
    if (!remaining.delete(key)) throw invalidTemplate();
    return xmlText(fields[key]);
  });
  if (remaining.size) throw invalidTemplate();
  return filled;
}

export function actFilename(data: ActDocumentData): string {
  const safe = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 68);
  return 'Акт ' + safe(data.number) + ' от ' + data.actDate.split('-').reverse().join('.') + ' — ' + safe(data.vehicle) + '.docx';
}

export async function generateActDocument(template: Uint8Array, data: ActDocumentData): Promise<Uint8Array<ArrayBuffer>> {
  if (!data.jobs.length) throw new Error('В заказе нет выполненных работ.');
  const mode = data.mode ?? 'weighted';
  const listed = mode === 'names' ? null : data.jobs.reduce((sum, job) =>
    validActAmount(sum + validActAmount(job.kopeks!)), 0);
  const total = validActAmount(data.agreedTotal ?? listed!);
  if (mode === 'weighted' && total !== listed || mode === 'discount' && (listed == null || total > listed)) {
    throw new Error('Проверьте договорную сумму и цены работ.');
  }
  const fields = {
    ACT_NUMBER: data.number, CONTRACT_NUMBER: data.contractNumber,
    CONTRACT_DATE: actDateLabel(data.contractDate, 'года'), ACT_DATE: actDateLabel(data.actDate, 'г.'),
    VEHICLE: data.vehicle, VIN: data.vin.trim() || '_________________', TOTAL: actTotal(total),
  };
  const zip = await JSZip.loadAsync(template);
  const part = zip.file(documentPath);
  if (!part) throw invalidTemplate();
  const xml = await part.async('string');
  const segments = xml.split(start);
  if (segments.length !== 2) throw invalidTemplate();
  const [before, tail] = segments;
  const sections = tail.split(end);
  if (sections.length !== 2) throw invalidTemplate();
  const [prototype, after] = sections;
  // Expand only the prepared work paragraph. User-entered text never passes
  // through a second replacement, even if it looks like a template field.
  const staticParts = replaceSlots(before + start + after, fields).split(start);
  let jobs: string[];
  if (mode === 'names') {
    // In existing private masters the dash, amount and BYN may occupy separate styled runs.
    replaceSlots(prototype, { JOB_NAME: 'x', JOB_PRICE: '0' });
    const namesOnly = prototype.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g,
      (_match, open, content, close) => open + (content.includes('{{GARAGE_JOB_NAME}}') ? '{{GARAGE_JOB_NAME}}' : '') + close);
    jobs = data.jobs.map(job => replaceSlots(namesOnly, { JOB_NAME: job.name }));
  } else {
    jobs = data.jobs.map(job => replaceSlots(prototype, { JOB_NAME: job.name, JOB_PRICE: actPrice(job.kopeks!) }));
    if (mode === 'discount' && listed! > total) {
      jobs.push(replaceSlots(prototype, { JOB_NAME: 'Скидка', JOB_PRICE: '−' + actPrice(listed! - total) }));
    }
  }
  zip.file(documentPath, staticParts[0] + jobs.join('') + staticParts[1]);
  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  return new Uint8Array(buffer);
}
