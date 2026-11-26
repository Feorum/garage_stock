import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import JSZip from 'jszip';
import { actPrice, actTotal, actDateLabel } from '../src/act-amounts.js';
import { actFilename, generateActDocument } from '../src/act-document.ts';

const skeleton = readFileSync(new URL('fixtures/act-template.xml', import.meta.url), 'utf8');
const data = {
  number: 'Д/3', contractNumber: 'ДГ-1', actDate: '2028-02-29', contractDate: '2027-01-07',
  vehicle: 'Модель <Т>', vin: 'TEST0000000000123',
  jobs: [{ name: 'Оклейка & защита', kopeks: 4101 }, { name: 'Подарок', kopeks: 0 }],
};

async function fixture(xml = skeleton) {
  const zip = new JSZip();
  zip.file('word/document.xml', xml);
  zip.file('word/styles.xml', '<styles/>');
  zip.file('word/fonts/font1.odttf', new Uint8Array([0, 7, 255]));
  return zip.generateAsync({ type: 'uint8array' });
}

test('act uses editable work paragraphs and preserves the rest of the Word package', async () => {
  const output = await generateActDocument(await fixture(), data);
  const zip = await JSZip.loadAsync(output);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Акт №Д\/3/);
  assert.match(xml, /ДГ-1 «07» января 2027 года/);
  assert.match(xml, /«29» февраля 2028 г\./);
  assert.match(xml, /Модель &lt;Т&gt;, VIN TEST0000000000123/);
  assert.match(xml, /Оклейка &amp; защита.*41,01 BYN/);
  assert.match(xml, /Подарок.*0,00 BYN/);
  assert.match(xml, /41 \(сорок один\) белорусский рубль, 01 копейка без НДС\./);
  assert.match(xml, /Подписи сторон/);
  assert.doesNotMatch(xml, /garage-jobs|\{\{GARAGE/);
  assert.equal((xml.match(/<\/w:p>/g) || []).length, 7);
  assert.equal(await zip.file('word/styles.xml').async('string'), '<styles/>');
  assert.deepEqual(await zip.file('word/fonts/font1.odttf').async('uint8array'), new Uint8Array([0, 7, 255]));
  assert.equal(actFilename(data), 'Акт Д-3 от 29.02.2028 — Модель -Т-.docx');
});

test('user data is inserted literally, including template-like text', async () => {
  const zip = await JSZip.loadAsync(await generateActDocument(await fixture(), { ...data,
    vehicle: '{{GARAGE_TOTAL}}', jobs: [{name: '{{GARAGE_VEHICLE}} <?garage-jobs-start?>', kopeks: 0}],
  }));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Автомобиль \{\{GARAGE_TOTAL\}\}/);
  assert.match(xml, /\{\{GARAGE_VEHICLE\}\} &lt;\?garage-jobs-start\?&gt;/);
  assert.match(xml, /0 \(ноль\) белорусских рублей, 00 копеек/);
});

test('Russian total in words agrees with thousands, large amounts and kopeks', () => {
  const cases = [
    [202, '2 (два) белорусских рубля, 02 копейки'],
    [512, '5 (пять) белорусских рублей, 12 копеек'],
    [1114, '11 (одиннадцать) белорусских рублей, 14 копеек'],
    [2121, '21 (двадцать один) белорусский рубль, 21 копейка'],
    [100012, '1000 (одна тысяча) белорусских рублей, 12 копеек'],
    [200101, '2001 (две тысячи один) белорусский рубль, 01 копейка'],
    [11142099, '111420 (сто одиннадцать тысяч четыреста двадцать) белорусских рублей, 99 копеек'],
    [200000100, '2000001 (два миллиона один) белорусский рубль, 00 копеек'],
    [100100100110, '1001001001 (один миллиард один миллион одна тысяча один) белорусский рубль, 10 копеек'],
    [100000000000012, '1000000000000 (один триллион) белорусских рублей, 12 копеек'],
  ];
  for (const [kopeks, expected] of cases) assert.equal(actTotal(kopeks), expected);
  assert.equal(actPrice(7), '0,07');
  assert.equal(actPrice(Number.MAX_SAFE_INTEGER), '90071992547409,91');
});

test('incomplete template and unknown prices cannot produce an act', async () => {
  const bytes = await fixture();
  for (const jobs of [[], [{ name: 'Работа', kopeks: null }], [{ name: 'Работа', kopeks: -1 }],
    [{ name: 'Работа', kopeks: 2.2 }], [{ name: ' ', kopeks: 0 }],
    [{ name: 'А', kopeks: Number.MAX_SAFE_INTEGER }, { name: 'Б', kopeks: 1 }]])
    await assert.rejects(generateActDocument(bytes, { ...data, jobs }));
  for (const xml of [skeleton.replace('{{GARAGE_CONTRACT_DATE}}', ''), skeleton.replace('<?garage-jobs-end?>', ''),
    skeleton.replace('{{GARAGE_JOB_NAME}}', '{{GARAGE_JOB_NAME}}{{GARAGE_JOB_NAME}}')])
    await assert.rejects(generateActDocument(await fixture(xml), data), /Форма акта/);
  assert.throws(() => actDateLabel('2027-02-29', 'г.'));
  assert.throws(() => actDateLabel('2026-2-3', 'г.'));
  await assert.rejects(generateActDocument(bytes, { ...data, number: 'x\u000b' + 'y' }));
});

test('negotiated 750 BYN can be issued in each layout using the same Word master', async () => {
  async function rendered(mode, prices) {
    const bytes = await generateActDocument(await fixture(), { ...data, mode, agreedTotal: 75000,
      jobs: prices.map((kopeks, i) => ({ name: i ? 'Зеркала' : 'Капот', kopeks })) });
    const zip = await JSZip.loadAsync(bytes);
    return (await zip.file('word/document.xml').async('string')).replace(/<[^>]*>/g, '');
  }
  assert.match(await rendered('weighted', [45000, 30000]), /1\. Капот \(450,00 BYN\), Зеркала \(300,00 BYN\) – 750,00 BYN/);
  assert.match(await rendered('discount', [48000, 32000]), /1\. Капот \(480,00 BYN\), Зеркала \(320,00 BYN\) – 800,00 BYN\s*Скидка – −50,00 BYN/);
  const names = await rendered('names', [null, null]);
  assert.match(names, /1\. Капот, Зеркала\s*Итого 750 \(семьсот пятьдесят\)/);
  assert.doesNotMatch(names, /BYN| – |Скидка/);
  await assert.rejects(rendered('weighted', [48000, 32000]));
  await assert.rejects(rendered('discount', [20000, 30000]));
});

test('ordinary works and W19 tint use consecutive service lines regardless of input order', async () => {
  const tinted = { name: 'Задняя полусфера · 5%', workCode: 'W19', kopeks: 3251 };
  const otherTint = { name: 'Задняя полусфера · 15%', workCode: 'W19', kopeks: 2701 };
  const ordinary = { name: 'Капот', workCode: 'W01', kopeks: 12455 };
  const gift = { name: 'Подарочная работа', workCode: 'W09', kopeks: 0 };
  const bytes = await fixture();
  async function jobParagraphs(jobs, mode = 'weighted', agreedTotal = null) {
    const zip = await JSZip.loadAsync(await generateActDocument(bytes, { ...data, jobs, mode, agreedTotal }));
    const xml = await zip.file('word/document.xml').async('string');
    return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)]
      .map(match => match[1].replace(/<[^>]*>/g, ''))
      .filter(text => /^([12]\. |Скидка)/u.test(text));
  }
  assert.deepEqual(await jobParagraphs([tinted, ordinary, otherTint, gift]), [
    '1. Капот (124,55 BYN), Подарочная работа (0,00 BYN) – 124,55 BYN',
    '2. Задняя полусфера · 5% (32,51 BYN), Задняя полусфера · 15% (27,01 BYN) – 59,52 BYN',
  ]);
  assert.deepEqual(await jobParagraphs([ordinary, tinted], 'discount', 11000), [
    '1. Капот – 124,55 BYN', '2. Задняя полусфера · 5% – 32,51 BYN', 'Скидка – −47,06 BYN',
  ]);
  assert.deepEqual(await jobParagraphs([tinted]), ['1. Задняя полусфера · 5% – 32,51 BYN']);
  assert.deepEqual(await jobParagraphs([otherTint, tinted], 'names', 10000),
    ['1. Задняя полусфера · 15%, Задняя полусфера · 5%']);
});

test('original Word list numbering cannot duplicate group numbers or number the discount', async () => {
  for (const properties of [
    '<w:pStyle w:val="ListParagraph"/><w:keepNext/><w:spacing w:after="10"/>',
    '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr>',
  ]) {
    const original = skeleton.replace('<w:p><w:r><w:t>{{GARAGE_JOB_NAME}}',
      '<w:p><w:pPr>' + properties + '</w:pPr><w:r><w:t>{{GARAGE_JOB_NAME}}');
    const zip = await JSZip.loadAsync(await generateActDocument(await fixture(original), {
      ...data, mode: 'discount', agreedTotal: 10,
    }));
    const xml = await zip.file('word/document.xml').async('string');
    assert.equal((xml.match(/<w:numId w:val="0"\/>/g) || []).length, 2);
    assert.doesNotMatch(xml, /w:numId w:val="4"/);
  }
});
