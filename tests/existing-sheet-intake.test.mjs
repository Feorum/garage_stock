// Synthetic requests only. Intake evidence never goes to mechanic payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExistingSheetRows } from '../supabase/functions/pull-manager-sheets/parser.ts';
import { intakeRows, ownerBindings } from '../supabase/functions/pull-manager-sheets/intake.ts';

const HEADER = ['Столбец 1','День','Менеджер','Автомобиль','VIN','Цвет','Оклейка','Тонировка','Готовность','Примечание'];
const request = (changes = {}) => {
  const row = ['2026-11-13','#REF!','Synthetic manager','S50','TEST0000000000001','Grey','W01','','FALSE',''];
  for (const [column, value] of Object.entries(changes)) row[Number(column)] = value;
  return row;
};

test('intake retains exact free writing and partial form fields when identity and work are invalid', () => {
  const source = request({0:' 23.11 ',2:' Manager ',3:'',4:' invalid-vin ',6:' Custom request\nsecond line ',8:false,9:' Original note '});
  const parsed = parseExistingSheetRows([HEADER,source]);
  const [item] = intakeRows(parsed);
  assert.equal(item.source_key,null);
  assert.equal(parsed.rows[0].order,null);
  assert.deepEqual(item.raw,{date:' 23.11 ',manager_label:' Manager ',vehicle:'',vin:' invalid-vin ',colour:'Grey',
    wrapping:' Custom request\nsecond line ',tint:'',completion:'false',notes:' Original note '});
  assert.equal(item.suggested_order.planned_date,null);
  assert.equal(item.suggested_order.vehicle_group_code,null);
  assert.equal(item.suggested_order.manager_label,'Manager');
  assert.deepEqual(item.suggested_tasks,[]);
  assert.ok(item.issues.includes('NO_APPROVED_TASKS'));
  assert.ok(!JSON.stringify(item).includes('#REF!'));
});

test('capture preserves duplicate observations and completed provenance but ignores templates', () => {
  const a=request(), b=request({6:'W09'}), history=request({4:'TEST0000000000002',8:true});
  const first=intakeRows(parseExistingSheetRows([HEADER,a,b,history,['','','','','','','','',false],['Date notice']]));
  const sorted=intakeRows(parseExistingSheetRows([HEADER,b,history,a]));
  assert.equal(first.length,3);
  assert.equal(first[0].source_key,first[1].source_key);
  assert.notDeepEqual(first[0].raw,first[1].raw);
  assert.equal(first[2].raw.completion,'true');
  assert.equal(first[2].suggested_order,null);
  assert.deepEqual(first.map(x=>JSON.stringify(x.raw)).sort(),sorted.map(x=>JSON.stringify(x.raw)).sort());
  assert.ok(first.slice(0,2).every(x=>x.issues.includes('DUPLICATE_SOURCE_KEY')));
});

test('raw evidence does not change canonical submission objects and bindings are read-specific', () => {
  const parsed=parseExistingSheetRows([HEADER,request()]);
  const [row]=parsed.rows;
  assert.deepEqual(Object.keys(row.order).sort(),['colour','due_date','instructions','manager_label','planned_date','priority','vehicle','vehicle_group_code','vin']);
  assert.ok(!JSON.stringify({order:row.order,tasks:row.tasks}).includes('raw'));
  assert.deepEqual(ownerBindings({version:7,owner_managed_keys:[row.source_key],owner_managed_rows:[2]},7,parsed),
    {ownerManagedKeys:[row.source_key],ownerManagedRows:[2]});
  for (const value of [{version:8,owner_managed_keys:[],owner_managed_rows:[]},
    {version:7,owner_managed_keys:[],owner_managed_rows:[99]},
    {version:7,owner_managed_keys:['row:2'],owner_managed_rows:[]}]) {
    assert.throws(()=>ownerBindings(value,7,parsed),/INVALID_INTAKE_BINDINGS/);
  }
});
