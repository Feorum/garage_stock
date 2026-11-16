// A small expression reader for the workbook's arithmetic. It never executes code.
const COLUMN = /^\$?([A-Z]{1,3})\$?([1-9]\d*)/i;

export function columnNumber(column) {
  return [...column.toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

export function columnName(value) {
  let name = '';
  while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
  return name;
}

function numeric(value) {
  if (value === null || value === '') return 0;
  if (Array.isArray(value)) throw new Error('A range needs a supported function.');
  if (typeof value === 'string') {
    value = value.trim();
    // This workbook uses decimal-comma text in several exchange-rate inputs.
    if (/^[+-]?(?:\d+(?:,\d+)?|,\d+)$/.test(value)) value = value.replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value)) {
      throw new Error('A referenced value is not numeric.');
    }
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('A referenced value is not numeric.');
  return result;
}

export function readLedgerFormula(formula, sheet, lookup) {
  if (typeof formula !== 'string' || formula.length > 20000 || !formula.startsWith('=')) {
    throw new Error('This formula needs Owner review.');
  }
  let index = 1, steps = 0;
  const space = () => { while (/\s/.test(formula[index] || '') && index < formula.length) index++; };
  function consume(text) {
    space();
    if (formula.slice(index, index + text.length) !== text) return false;
    index += text.length;
    return true;
  }
  function reference(defaultSheet) {
    space();
    const start = index;
    let target = defaultSheet;
    const prefix = formula.slice(index).match(/^(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!/u);
    if (prefix) { target = (prefix[1] ?? prefix[2]).replaceAll("''", "'"); index += prefix[0].length; }
    const match = formula.slice(index).match(COLUMN);
    if (!match) { index = start; return null; }
    const column = match[1].toUpperCase(), row = Number(match[2]);
    if (columnNumber(column) > 16384 || row > 1048576) throw new Error('The cell reference is outside the workbook.');
    index += match[0].length;
    return { sheet: target, column, row };
  }
  function primary() {
    if (++steps > 20000) throw new Error('The formula is too complex to calculate here.');
    space();
    if (consume('(')) { const value = expression(); if (!consume(')')) throw new Error('Unclosed formula.'); return value; }
    const number = formula.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/);
    if (number) { index += number[0].length; return Number(number[0]); }
    const fn = formula.slice(index).match(/^(SUM|MIN|AVERAGE)\s*\(/i);
    if (fn) {
      index += fn[0].length;
      const args = [];
      if (!consume(')')) {
        do { args.push(expression()); } while (consume(','));
        if (!consume(')')) throw new Error('This function needs review.');
      }
      const numbers = args.flat().filter(value => typeof value === 'number');
      if (fn[1].toUpperCase() === 'SUM') return numbers.reduce((sum, value) => sum + value, 0);
      if (fn[1].toUpperCase() === 'MIN') return numbers.length ? Math.min(...numbers) : 0;
      if (!numbers.length) throw new Error('An average has no numeric inputs.');
      return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    }
    const from = reference(sheet);
    if (from) {
      if (!consume(':')) return lookup(from.sheet, from.column, from.row);
      const to = reference(from.sheet);
      if (!to || to.sheet !== from.sheet) throw new Error('This range needs review.');
      const left = Math.min(columnNumber(from.column), columnNumber(to.column));
      const right = Math.max(columnNumber(from.column), columnNumber(to.column));
      const top = Math.min(from.row, to.row), bottom = Math.max(from.row, to.row);
      if ((right - left + 1) * (bottom - top + 1) > 100000) throw new Error('The range is too large.');
      const values = [];
      for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) values.push(lookup(from.sheet, columnName(col), row));
      }
      return values;
    }
    throw new Error(formula.includes('#REF!') ? 'The source contains a broken reference.' : 'This formula needs Owner review.');
  }
  function unary() {
    if (consume('+')) return numeric(unary());
    if (consume('-')) return -numeric(unary());
    let value = primary();
    while (consume('%')) value = numeric(value) / 100;
    return value;
  }
  function power() {
    let value = unary();
    while (consume('^')) value = numeric(value) ** numeric(unary());
    return value;
  }
  function product() {
    let value = power();
    for (;;) {
      if (consume('*')) value = numeric(value) * numeric(power());
      else if (consume('/')) {
        const divisor = numeric(power());
        if (divisor === 0) throw new Error('Division by zero needs review.');
        value = numeric(value) / divisor;
      } else return value;
    }
  }
  function expression() {
    let value = product();
    for (;;) {
      if (consume('+')) value = numeric(value) + numeric(product());
      else if (consume('-')) value = numeric(value) - numeric(product());
      else return value;
    }
  }
  const value = expression();
  space();
  if (index !== formula.length || Array.isArray(value)) throw new Error('This formula needs Owner review.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('The result is not a finite number.');
  return value;
}
