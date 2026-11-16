import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerCalculator } from '../src/ledger-calculations.js';
import { readLedgerFormula } from '../src/ledger-formula-parser.js';

const num = value => ({ type: 'number', value });
const formula = (value, expression) => ({ type: 'number', value, formula: expression });
function fixture() {
  return { sheets: [
    { name: 'Month', rows: [
      { source_row: 2, cells: { A: num(100), B: num(20), C: formula(70, '=A2-B2-SUM(D2:F2)'), D: num(10) } },
      { source_row: 3, cells: { A: num(40), B: formula(7, '=A3*5%'), C: formula(140, '=SUM(A2:A3)') } },
      { source_row: 4, archived: true, cells: { A: num(900) } },
      { source_row: 5, cells: { A: formula(0, '=SUM(A2:A4)') } },
    ] },
    { name: "O'Brien month", rows: [{ source_row: 1, cells: { A: formula(0, '=Month!C2+MIN(Month!A2:A3)') } }] },
  ] };
}

test('recalculates source arithmetic rather than using stale cached values', () => {
  const context = fixture();
  assert.equal(createLedgerCalculator(context).getCell('Month', 'B', 3).value, 2);
  context.sheets[0].rows[0].cells.B.value = 30;
  assert.equal(createLedgerCalculator(context).getCell('Month', 'C', 2).value, 60);
});
test('ranges ignore archived rows and blank cells, preserve explicit zero', () => {
  const calc = createLedgerCalculator(fixture());
  assert.equal(calc.getCell('Month', 'A', 5).value, 140);
  assert.deepEqual(calc.getCell('Month', 'Z', 2), { status: 'blank', value: null });
  assert.equal(readLedgerFormula('=SUM(A1:B2)', 'Blank', () => null), 0);
});
test('tracks cross-sheet and quoted Unicode references', () => {
  const calc = createLedgerCalculator(fixture());
  assert.equal(calc.getCell("O'Brien month", 'A', 1).value, 110);
  assert.equal(readLedgerFormula("='O''Brien month'!$A$1+SUM('Ноябрь'!A1:B1)", 'Month', () => 3), 9);
});
test('supports percentage, precedence, MIN and AVERAGE', () => {
  assert.equal(readLedgerFormula('=(100+20)*5%+2^3', 'Month', () => null), 14);
  assert.equal(readLedgerFormula('=2^3^2', 'Month', () => null), 64);
  assert.equal(readLedgerFormula('=AVERAGE(A1:C1)', 'Month', (_, col) => ({ A: 10, B: null, C: 20 })[col]), 15);
});
test('errors propagate instead of reusing cached results', () => {
  for (const expression of ['=#REF!*5%', '=1/0', '=UNSUPPORTED(A2)', '=A2+globalThis.alert(1)', '=SUM(A1:A1048576)']) {
    const context = fixture();
    context.sheets[0].rows[0].cells.C = formula(999, expression);
    assert.equal(createLedgerCalculator(context).getCell('Month', 'C', 2).status, 'error', expression);
  }
});
test('detects cycles and missing sheets', () => {
  const context = fixture();
  context.sheets[0].rows[0].cells.C = formula(1, '=C2');
  assert.equal(createLedgerCalculator(context).getCell('Month', 'C', 2).status, 'error');
  context.sheets[0].rows[0].cells.C.formula = "='Unknown'!A1";
  assert.equal(createLedgerCalculator(context).getCell('Month', 'C', 2).status, 'error');
});
test('coerces verified decimal-comma operands while SUM still ignores text', () => {
  assert.equal(readLedgerFormula('=A1*2', 'Month', () => '3,05'), 6.1);
  assert.equal(readLedgerFormula('=SUM(A1:A2)', 'Month', () => '3,05'), 0);
  assert.throws(() => readLedgerFormula('=A1*2', 'Month', () => '0x10'));
});
test('Owner overrides feed downstream totals and can return to the formula', () => {
  const context = fixture();
  context.sheets[0].rows[0].cells.C = { ...formula(25, '=#REF!'), override: true };
  assert.equal(createLedgerCalculator(context).getCell('Month', 'C', 2).status, 'override');
  assert.equal(createLedgerCalculator(context).getCell("O'Brien month", 'A', 1).value, 65);
  context.sheets[0].rows[0].cells.C.override = false;
  assert.equal(createLedgerCalculator(context).getCell("O'Brien month", 'A', 1).status, 'error');
});
test('new rows retain values but cannot pretend to have source formula addresses', () => {
  const calc = createLedgerCalculator(fixture());
  assert.equal(calc.evaluateRow('Month', { cells: { A: num(0) } }).A.value, 0);
  assert.equal(calc.evaluateRow('Month', { cells: { A: formula(999, '=A2') } }).A.status, 'error');
});
