// Browser-test fixture only. The public build does not include this module.
export function createClient() {
  const fixture = globalThis.__garageTest || {};
  const ledgerRpc = globalThis.__garageCreateLedgerFake?.(fixture);
  const calls = globalThis.__garageCalls = [];
  const listeners = new Set();
  const user = { id: fixture.userId || '11111111-1111-4111-8111-111111111111' };
  let session = fixture.signedIn === false ? null : { user };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms || 0));
  const emit = (event, next = session) => {
    session = next;
    for (const callback of listeners) callback(event, session);
  };

  globalThis.__garageAuth = {
    signOut: () => emit('SIGNED_OUT', null),
    signIn: () => emit('SIGNED_IN', { user }),
    refresh: () => emit('TOKEN_REFRESHED', session),
  };

  const profile = async () => {
    const row = fixture.profile === undefined
      ? { name: 'Test Owner', role: 'admin' } : fixture.profile;
    const error = fixture.profileError;
    await pause(fixture.profileDelay);
    return { data: row, error: error ? { message: error } : null };
  };

  // These records are synthetic fixtures, never copies of uploaded business data.
  const clone = value => JSON.parse(JSON.stringify(value));
  const orders = clone(fixture.orders || []);
  const managerIntakes = clone(fixture.managerIntakes || []);
  const sheetSources = clone(fixture.sheetSources || []);
  const sheetReviews = clone(fixture.sheetReviews || {});
  const sheetReaderSecrets = new Map();
  const staff = clone(fixture.staff || [
    { id: user.id, name: 'Test Mechanic' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Other Mechanic' },
  ]);
  const receipts = new Map();
  const pricing = new Map();
  const errorCounts = new Map();
  let serial = 0;
  let lostCreateResponse = false;
  let lostSheetRegisterResponse = false;
  let lostSheetReaderResponse = false;
  let lostCompletionResponse = false;
  const currentRole = () => (fixture.profile === undefined ? 'admin' : fixture.profile?.role);
  const errorResult = (message, code = 'P0001') => ({ data: null, error: { message, code } });
  const workName = code => ({ W01: 'капот полностью', W02: 'Бампер', W10: 'Стойки лобового (2шт)', W13: 'Зеркала', W19: 'тонировка задней полусферы (5%,15%)' }[code] || code);
  const memberName = id => staff.find(row => row.id === id)?.name || (id === user.id ? fixture.profile?.name : '') || 'Механик';
  function members(task) {
    if (task.participants) return clone(task.participants);
    const ids = task.mechanic_ids || [task.working_mechanic_id || task.assigned_to].filter(Boolean);
    const status = { pending: 'assigned', in_progress: 'working', blocked: 'blocked', completed: 'confirmed' }[task.status] || 'assigned';
    return ids.map(mechanic_id => ({ mechanic_id, name: memberName(mechanic_id), status, confirmed_at: task.completed_at || null }));
  }
  const taskVisible = task => members(task).some(person => person.mechanic_id === user.id);
  function readable(task) {
    const participants = members(task);
    const me = participants.find(person => person.mechanic_id === user.id);
    const can_see_notes = currentRole() === 'admin' || Boolean(me);
    return { ...clone(task), participants, my_status: me?.status || null, can_see_notes,
      roster_locked: participants.some(person => person.status === 'confirmed'),
      notes: can_see_notes ? clone(task.notes || []) : [], blocker_reason: can_see_notes ? task.blocker_reason : '' };
  }
  function workflow(order) {
    const tasks = order.tasks || [];
    const activeTask = tasks.find(task => ['in_progress', 'blocked'].includes(task.status));
    const activeMember = activeTask && members(activeTask).find(member => ['working', 'blocked'].includes(member.status));
    return order.vehicle_workflow ||= {
      state: order.status === 'published' ? (activeTask ? 'active' : 'available') : order.status,
      holder_id: activeTask?.working_mechanic_id || activeMember?.mechanic_id || null,
      origin: activeTask ? 'existing_work' : null, taken_at: null, handed_at: null, handoff_note: '', handoff_tasks: [],
    };
  }
  function readableWorkflow(order, tasks) {
    const current = workflow(order);
    const owner = currentRole() === 'admin';
    const mine = current.holder_id === user.id;
    const completed = tasks.filter(task => task.status === 'completed').length;
    const unfinished = tasks.filter(task => !['completed', 'cancelled'].includes(task.status)).length;
    return { ...clone(current), holder_name: current.holder_id ? memberName(current.holder_id) : null,
      completed_count: completed, unfinished_count: unfinished,
      can_take: !owner && current.state === 'available' && tasks.some(task => task.status !== 'cancelled' &&
        (order.source === 'manager' && task.status !== 'completed' || taskVisible(task))),
      can_handoff: !owner && current.state === 'active' && mine,
      can_return: owner && current.state === 'review',
      can_close: owner && ['available', 'review'].includes(current.state) && !unfinished && completed > 0,
      handoff_note: owner || mine ? current.handoff_note : '',
      handoff_tasks: owner || mine ? (current.handoff_tasks || []).filter(snapshot => tasks.some(task => task.id === snapshot.id)) : [],
      return_note: owner || mine ? current.return_note || '' : '',
    };
  }
  function withTaskPricing(summary) {
    const itemKey = 'tasks' in summary ? 'tasks' : 'items';
    const items = (summary[itemKey] || []).map(item => {
      const stored = pricing.get(item.task_id);
      const catalogue = item.catalogue_kopeks ?? (item.net_amount != null ? Math.round(item.net_amount * 100) : null);
      const override = stored?.override_kopeks ?? null;
      const effective = override ?? catalogue;
      const tax = effective !== null && item.net_amount != null ? Math.round(effective * (item.vat_rate ?? .2)) : null;
      return {...item, catalogue_kopeks: catalogue, effective_kopeks: effective,
        effective_tax_kopeks: tax, effective_gross_kopeks: tax !== null ? effective + tax : null,
        override_kopeks: override, private_comment: stored?.private_comment || '', private_version: stored?.version || 0};
    });
    const total = items.length && items.every(item => item.effective_kopeks != null)
      ? items.reduce((sum, item) => sum + item.effective_kopeks, 0) : null;
    const tax = items.length && items.every(item => item.effective_tax_kopeks != null)
      ? items.reduce((sum, item) => sum + item.effective_tax_kopeks, 0) : null;
    return {...summary, [itemKey]: items, effective_total_kopeks: total, effective_tax_kopeks: tax,
      effective_gross_kopeks: tax !== null && total !== null ? total + tax : null};
  }
  const visibleOrders = () => orders.flatMap(order => {
    const showAll = currentRole() === 'admin' || order.source === 'manager' && order.status === 'published';
    const tasks = (order.tasks || []).filter(task => showAll || taskVisible(task)).map(readable);
    const holding = order.status === 'published' && workflow(order).holder_id === user.id;
    return tasks.length || holding ? [{ ...clone(order), tasks, vehicle_workflow: readableWorkflow(order, tasks) }] : [];
  });
  globalThis.__garageOrderState = { orders, receipts, staff, managerIntakes };
  globalThis.__garageSheetState = { sources: sheetSources };

  async function rpc(name, args = {}) {
    const authenticatedAtRequest = Boolean(session);
    const frozenSheetList = name === 'garage_sheet_pull_sources' && fixture.freezeSheetListSnapshot ? clone(sheetSources) : null;
    calls.push({ method: 'rpc', name, args: clone(args) });
    await pause(fixture.rpcDelays?.[name] ?? fixture.rpcDelay);
    const configuredError = fixture.rpcErrors?.[name];
    if (configuredError) {
      const count = errorCounts.get(name) || 0;
      errorCounts.set(name, count + 1);
      if (typeof configuredError === 'string' || count < (configuredError.times || 1)) {
        return errorResult(typeof configuredError === 'string' ? configuredError : configuredError.message, configuredError.code || 'P0001');
      }
    }
    if (!session && !(fixture.allowLateRpcResponse && authenticatedAtRequest)) return errorResult('Sign in to continue.', '42501');
    if (globalThis.__garageRpcFixture) return globalThis.__garageRpcFixture(name, args);
    const owner = currentRole() === 'admin';
    if (name.startsWith('garage_ledger_') && ledgerRpc) return ledgerRpc(name, args, owner);
    if (['garage_sheet_pull_sources', 'garage_connect_sheet_pull', 'garage_sheet_pull_reviews', 'garage_prepare_sheet_reader', 'garage_set_sheet_active'].includes(name)) {
      if (!owner) return errorResult('Owner access required.', '42501');
      if (name === 'garage_sheet_pull_sources') return { data: frozenSheetList || clone(sheetSources), error: null };
      if (name === 'garage_sheet_pull_reviews') return { data: clone(sheetReviews[args.p_source_id] || []), error: null };
      if (name === 'garage_connect_sheet_pull') {
        if (!args.p_name?.trim() || !/^[A-Za-z0-9_-]{20,200}$/.test(args.p_spreadsheet_id || '')
            || !Number.isSafeInteger(args.p_sheet_gid) || args.p_sheet_gid < 0 || args.p_sheet_gid > 2147483647) {
          return errorResult('Connection fields are invalid.');
        }
        let source = sheetSources.find(row => row.spreadsheet_id === args.p_spreadsheet_id && row.sheet_gid === args.p_sheet_gid);
        if (!source) {
          serial += 1;
          source = {
            id: `33333333-3333-4333-8333-${String(serial).padStart(12, '0')}`,
            name: args.p_name.trim(), spreadsheet_id: args.p_spreadsheet_id, sheet_gid: args.p_sheet_gid,
            mode: 'pull', reader_only: true, active: true, version: 1, last_success_at: null, last_error_code: null,
            review_count: 0, summary: {}, created_at: '2026-11-13T10:00:00Z',
          };
          sheetSources.push(source);
        }
        if (fixture.loseSheetRegisterResponseOnce && !lostSheetRegisterResponse) {
          lostSheetRegisterResponse = true;
          return errorResult('Network response was lost. Retry the same request.', 'NETWORK');
        }
        return { data: clone(source), error: null };
      }
      const source = sheetSources.find(row => row.id === args.p_source_id);
      if (!source) return errorResult('Connection not found.');
      if (name === 'garage_prepare_sheet_reader') {
        if (source.version === args.p_expected_version + 1 && sheetReaderSecrets.get(source.id) === args.p_secret) return { data: clone(source), error: null };
        if (source.version !== args.p_expected_version) return errorResult('This connection changed. Refresh and try again.', '40001');
        if (!/^[A-Za-z0-9_-]{43}$/.test(args.p_secret || '')) return errorResult('A reader key is required.');
        sheetReaderSecrets.set(source.id, args.p_secret);
        source.reader_only = true;
        source.version += 1;
        if (fixture.loseSheetReaderResponseOnce && !lostSheetReaderResponse) {
          lostSheetReaderResponse = true;
          return errorResult('Network response was lost. Retry the same request.', 'NETWORK');
        }
        return { data: clone(source), error: null };
      }
      if (source.version !== args.p_expected_version) return errorResult('This connection changed. Refresh and try again.', '40001');
      source.active = args.p_active;
      source.version += 1;
      return { data: clone(source), error: null };
    }
    if (name === 'garage_list_orders') return { data: visibleOrders(), error: null };
    if (name === 'garage_owner_gift_offer') return owner ? { data: clone(fixture.giftOffer || null), error: null } : errorResult('Owner access required.', '42501');
    if (name === 'garage_manager_intakes') return owner ? { data: clone(managerIntakes), error: null } : errorResult('Owner access required.', '42501');
    if (name === 'garage_staff') return owner ? { data: clone(staff), error: null } : errorResult('Owner access required.', '42501');
    if (name === 'garage_order_financials') {
      if (!owner) return errorResult('Owner access required.', '42501');
      const order = orders.find(item => item.id === args.p_order_id);
      const items = (order?.tasks || []).map(task => ({ task_id: task.id, work_code: task.work_code, status: 'needs_pricing' }));
      return { data: withTaskPricing(clone(fixture.financials || { status: 'needs_pricing', currency: 'BYN', tasks: items, totals: null })), error: null };
    }
    if (name === 'garage_quote_order') {
      if (!owner) return errorResult('Owner access required.', '42501');
      const count = args.p_tasks?.length || 0;
      return { data: withTaskPricing(clone(fixture.quote || { status: 'priced', currency: 'BYN', net_amount: count * 100, vat_amount: count * 20, gross_amount: count * 120,
        items: (args.p_tasks || []).map(task => ({ task_id: task.id || null, work_code: task.work_code, status: 'priced', net_amount: 100, vat_amount: 20, gross_amount: 120 })) })), error: null };
    }
    const request = args.p_request_id;
    const fingerprint = JSON.stringify({ name, ...args });
    if (request && receipts.has(request)) {
      const receipt = receipts.get(request);
      return receipt.fingerprint === fingerprint ? clone(receipt.result) : errorResult('Request ID was already used for another action.');
    }
    // Translate the team editor payload to the same synthetic order store used by the legacy scenarios.
    if (name === 'garage_save_team_order') {
      const mode = args.p_mode;
      name = { new: 'garage_create_order', edit: 'garage_edit_order', intake: 'garage_publish_manager_intake' }[mode];
      args = { ...args, p_order_id: args.p_id, p_intake_id: args.p_id };
      if (mode === 'new') {
        for (const [key, value] of Object.entries(args.p_order)) args['p_' + key] = value;
      }
    } else if (name === 'garage_record_team_omission') {
      name = 'garage_record_omitted_completion';
      args = { ...args, p_mechanic_id: args.p_mechanic_ids[0] };
    }
    let result;
    let publishedIntake;
    if (name === 'garage_publish_manager_intake') {
      if (!owner) return errorResult('Owner access required.', '42501');
      publishedIntake = managerIntakes.find(row => row.id === args.p_intake_id);
      if (!publishedIntake || publishedIntake.version !== args.p_expected_version || publishedIntake.order_id) return errorResult('This request changed. Reopen it.', '40001');
      args = { ...args, ...Object.fromEntries(Object.entries(args.p_order || {}).map(([key, value]) => ['p_' + key, value])), p_source: 'manager' };
    }
    if (name === 'garage_create_order' || name === 'garage_publish_manager_intake') {
      if (!owner) return errorResult('Owner access required.', '42501');
      if (!args.p_vehicle?.trim() || !args.p_tasks?.length) return errorResult('Vehicle and work are required.');
      if (args.p_source === 'owner' && args.p_tasks.some(task => !task.assigned_to)) return errorResult('Assign every task to a mechanic.');
      if (args.p_source === 'manager' && args.p_tasks.some(task => task.assigned_to)) return errorResult('Shared tasks cannot have mandatory assignments.');
      if (args.p_tasks.some(task => task.work_code === 'W19' && ![5, 15].includes(task.options?.tint_percent))) return errorResult('Choose an approved tint percentage.');
      serial += 1;
      const orderId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(serial).padStart(12, '0')}`;
      const order = {
        id: orderId, order_number: `TEST-${String(serial).padStart(4, '0')}`,
        vehicle: args.p_vehicle, vin: args.p_vin || '', colour: args.p_colour || '',
        vehicle_group_code: args.p_vehicle_group_code, vehicle_group_name: 'Test vehicle group',
        source: args.p_source, status: 'published', instructions: args.p_instructions || '',
        planned_date: args.p_planned_date || null, due_date: args.p_due_date || null,
        priority: args.p_priority || 'normal', manager_label: args.p_manager_label || '',
        version: 1, created_at: '2026-11-12T10:00:00Z',
        tasks: args.p_tasks.map((task, index) => ({
          id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(serial * 100 + index).padStart(12, '0')}`,
          work_code: task.work_code, work_name: workName(task.work_code), options: task.options || {},
          status: 'pending', mechanic_ids: task.mechanic_ids, assigned_to: task.assigned_to || null,
          assigned_name: staff.find(row => row.id === task.assigned_to)?.name || null,
          working_mechanic_id: null, working_name: null, blocker_reason: '', version: 1, completed_at: null,
        })),
      };
      orders.unshift(order);
      if (publishedIntake) {
        order.source_id = publishedIntake.source_id; order.source_name = publishedIntake.source_name;
        order.source_row_number = publishedIntake.row_numbers[0];
        publishedIntake.order_id = order.id; publishedIntake.status = 'owner_managed'; publishedIntake.owner_managed = true; publishedIntake.version += 1;
      }
      result = { data: { ...clone(order), order_id: order.id, order_version: order.version }, error: null };
    } else if (name === 'garage_edit_order') {
      if (!owner) return errorResult('Owner access required.', '42501');
      const order = orders.find(row => row.id === args.p_order_id);
      if (!order || order.version !== args.p_expected_version) return errorResult('This order changed. Reopen it.', '40001');
      for (const task of order.tasks.filter(task => ['in_progress', 'blocked', 'completed'].includes(task.status))) {
        const updated = args.p_tasks.find(item => item.id === task.id);
        if (!updated || updated.work_code !== task.work_code || JSON.stringify(updated.options) !== JSON.stringify(task.options)) return errorResult('Recorded work must stay unchanged.');
      }
      Object.assign(order, args.p_order);
      order.tasks = args.p_tasks.map((item, index) => {
        const previous = order.tasks.find(task => task.id === item.id);
        return previous ? { ...previous, ...item } : {
          ...item, id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(900000 + index).padStart(12, '0')}`,
          work_name: workName(item.work_code), status: 'pending', working_mechanic_id: null, working_name: null,
          assigned_name: staff.find(row => row.id === item.assigned_to)?.name || null, version: 1, blocker_reason: '', completed_at: null,
        };
      });
      order.version += 1;
      const intake = managerIntakes.find(row => row.order_id === order.id);
      if (intake) { intake.owner_managed = true; intake.status = 'owner_managed'; intake.version += 1; }
      result = { data: { ...clone(order), order_id: order.id, order_version: order.version }, error: null };
    } else if (name === 'garage_record_omitted_completion') {
      if (!owner) return errorResult('Owner access required.', '42501');
      const order = orders.find(row => row.id === args.p_order_id);
      if (!order || order.version !== args.p_expected_version) return errorResult('This order changed. Reopen it.', '40001');
      if (order.status === 'cancelled' || !args.p_note?.trim() || !args.p_completed_at || !staff.some(row => row.id === args.p_mechanic_id)) return errorResult('Confirm the completed work and the mechanic.');
      if (order.tasks.some(task => task.status !== 'cancelled' && task.work_code === args.p_work_code && JSON.stringify(task.options || {}) === JSON.stringify(args.p_options || {}))) return errorResult('This work is already recorded.');
      serial += 1;
      const taskId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(800000 + serial).padStart(12, '0')}`;
      order.tasks.push({ id: taskId, work_code: args.p_work_code, work_name: workName(args.p_work_code),
        options: args.p_options || {}, instructions: '', status: 'completed', assigned_to: null, assigned_name: null,
        working_mechanic_id: args.p_mechanic_id, working_name: staff.find(row => row.id === args.p_mechanic_id).name,
        completed_at: args.p_completed_at, mechanic_ids: args.p_mechanic_ids, blocker_reason: '', version: 1 });
      order.version += 1;
      result = { data: { order_id: order.id, order_number: order.order_number, order_version: order.version, task_id: taskId }, error: null };
    } else if (name === 'garage_save_task_pricing') {
      if (!owner) return errorResult('Owner access required.', '42501');
      const old = pricing.get(args.p_task_id);
      if ((old?.version || 0) !== args.p_expected_version) return errorResult('Private price changed.', '40001');
      const version = args.p_expected_version + 1;
      pricing.set(args.p_task_id, { version, override_kopeks: args.p_override_kopeks, private_comment: args.p_private_comment });
      result = { data: version, error: null };
    } else if (name === 'garage_vehicle_action') {
      const order = orders.find(item => item.id === args.p_order_id);
      if (!order || (order.source === 'owner' && !owner && workflow(order).holder_id !== user.id &&
          !order.tasks.some(taskVisible))) return errorResult('Vehicle unavailable.', '42501');
      if (order.version !== args.p_expected_version) return errorResult('Vehicle version changed.', '40001');
      const current = workflow(order);
      const allowed = readableWorkflow(order, order.tasks);
      if (!allowed['can_' + args.p_action]) return errorResult('Vehicle action unavailable.', '42501');
      if (args.p_action === 'take') {
        current.state = 'active'; current.origin = 'explicit'; current.holder_id = user.id; current.taken_at = new Date().toISOString();
      } else if (args.p_action === 'handoff') {
        current.state = 'review'; current.handed_at = new Date().toISOString();
        current.handoff_note = args.p_note || '';
        current.handoff_tasks = order.tasks.map(({id, work_name, status}) => ({id, work_name, status}));
      } else if (args.p_action === 'return') {
        current.state = 'active'; current.return_note = args.p_note || '';
      }
      else if (args.p_action === 'close') { current.state = 'closed'; order.status = 'closed'; }
      order.version += 1;
      result = { data: { order_id: order.id, version: order.version, state: current.state }, error: null };
    } else if (name === 'garage_team_action') {
      const order = orders.find(row => row.tasks.some(task => task.id === args.p_task_id));
      const task = order?.tasks.find(row => row.id === args.p_task_id);
      if (!task || task.version !== args.p_expected_version) return errorResult('Task version changed.', '40001');
      if (!owner && workflow(order).state !== 'active') return errorResult('Take or reopen the vehicle first.', '42501');
      const participants = members(task);
      const me = participants.find(p => p.mechanic_id === user.id);
      const target = participants.find(p => p.mechanic_id === args.p_mechanic_id);
      const action = args.p_action;
      const person = id => ({ mechanic_id: id, name: memberName(id), status: 'assigned', confirmed_at: null });
      if (action === 'join' && order.source === 'manager' && !me && !participants.some(p => p.status === 'confirmed')) {
        participants.push({ ...person(user.id), status: 'working' });
      } else if (action === 'start' && me?.status === 'assigned') me.status = 'working';
      else if (action === 'block' && me?.status === 'working' && args.p_note?.trim()) me.status = 'blocked';
      else if (action === 'resume' && me?.status === 'blocked') me.status = 'working';
      else if (action === 'confirm' && me?.status === 'working') {
        me.status = 'confirmed'; me.confirmed_at = new Date().toISOString();
      } else if (action === 'leave' && me && order.source === 'manager' && !participants.some(p => p.status === 'confirmed')) {
        participants.splice(participants.indexOf(me), 1);
      } else if (owner && action === 'assign' && !target) participants.push(person(args.p_mechanic_id));
      else if (owner && ['replace', 'remove'].includes(action) && target && args.p_note?.trim()) {
        participants.splice(participants.indexOf(target), 1);
        if (action === 'replace') participants.push(person(args.p_replacement_id));
      } else if (!(action === 'note' && me && args.p_note?.trim())) return errorResult('Action unavailable.', '42501');
      if (args.p_note) {
        task.notes ||= [];
        task.notes.push({ id: crypto.randomUUID(), mechanic_id: user.id, name: memberName(user.id),
          note: args.p_note, created_at: new Date().toISOString(), action });
      }
      task.participants = participants;
      task.status = !participants.length || participants.every(p => p.status === 'assigned') ? 'pending'
        : participants.every(p => p.status === 'confirmed') ? 'completed'
        : participants.every(p => p.status === 'blocked') ? 'blocked' : 'in_progress';
      task.blocker_reason = action === 'block' ? args.p_note : '';
      if (task.status === 'completed') task.completed_at = new Date().toISOString();
      task.version += 1; order.version += 1;
      result = { data: { task_id: task.id, status: task.status, version: task.version }, error: null };
    } else if (name === 'garage_task_action') {
      const order = orders.find(row => row.tasks.some(task => task.id === args.p_task_id));
      const task = order?.tasks.find(row => row.id === args.p_task_id);
      if (!order || !task) return errorResult('Task not found.', '42501');
      if (task.version !== args.p_expected_version) return errorResult('This task changed. Refresh and try again.');
      if (order.status !== 'published') return errorResult('This order is no longer active.');
      const action = args.p_action;
      if (['reassign', 'cancel'].includes(action) && !owner) return errorResult('Owner access required.', '42501');
      if (action === 'start') {
        if (task.status !== 'pending') return errorResult('This task is already taken.');
        if (order.source === 'owner' && task.assigned_to !== user.id) return errorResult('This task belongs to another mechanic.', '42501');
        task.status = 'in_progress'; task.working_mechanic_id = user.id; task.working_name = fixture.profile?.name || 'Test Mechanic';
      } else if (['block', 'resume', 'complete', 'release'].includes(action)) {
        if (task.working_mechanic_id !== user.id) return errorResult('This task belongs to another mechanic.', '42501');
        if (action === 'release' && order.source !== 'manager') return errorResult('Owner assignments cannot return to the queue.');
        if (action === 'block' && !args.p_note?.trim()) return errorResult('A reason is required.');
        task.status = { block: 'blocked', resume: 'in_progress', complete: 'completed', release: 'pending' }[action];
        task.blocker_reason = action === 'block' ? args.p_note : '';
        if (action === 'complete') task.completed_at = '2026-11-12T11:00:00Z';
        if (action === 'release') { task.working_mechanic_id = null; task.working_name = null; }
      } else if (action === 'reassign') {
        if (!args.p_note?.trim() || !args.p_assignee) return errorResult('A mechanic and reason are required.');
        task.assigned_to = args.p_assignee;
        task.assigned_name = staff.find(row => row.id === args.p_assignee)?.name || null;
        if (task.working_mechanic_id) { task.working_mechanic_id = args.p_assignee; task.working_name = task.assigned_name; }
      } else if (action === 'cancel') {
        if (!args.p_note?.trim()) return errorResult('A reason is required.');
        task.status = 'cancelled';
      } else return errorResult('Unknown action.');
      task.version += 1;
      result = { data: clone(task), error: null };
    } else if (name === 'garage_order_action') {
      if (!owner) return errorResult('Owner access required.', '42501');
      const order = orders.find(row => row.id === args.p_order_id);
      if (!order) return errorResult('Order not found.');
      if (order.version !== args.p_expected_version) return errorResult('This order changed. Refresh and try again.');
      if (args.p_action === 'close' && order.tasks.some(task => !['completed', 'cancelled'].includes(task.status))) return errorResult('Complete or cancel outstanding tasks first.');
      if (args.p_action === 'cancel' && !args.p_note?.trim()) return errorResult('A reason is required.');
      order.status = args.p_action === 'close' ? 'closed' : 'cancelled';
      if (args.p_action === 'cancel') {
        for (const task of order.tasks) {
          if (!['completed', 'cancelled'].includes(task.status)) { task.status = 'cancelled'; task.version += 1; }
        }
      }
      order.version += 1;
      result = { data: { ...clone(order), order_id: order.id, order_version: order.version }, error: null };
    } else return errorResult(`Unexpected test RPC: ${name}`);
    if (request) receipts.set(request, { fingerprint, result: clone(result) });
    if (name === 'garage_create_order' && fixture.loseCreateResponseOnce && !lostCreateResponse) {
      lostCreateResponse = true;
      return errorResult('Network response was lost. Retry the same request.', 'NETWORK');
    }
    if (name === 'garage_record_omitted_completion' && fixture.loseCompletionResponseOnce && !lostCompletionResponse) {
      lostCompletionResponse = true;
      return errorResult('Network response was lost. Retry the same request.', 'NETWORK');
    }
    return result;
  }

  return {
    supabaseUrl: fixture.supabaseUrl || 'https://example.supabase.co',
    auth: {
      async getSession() {
        calls.push({ method: 'getSession' });
        await pause(fixture.sessionDelay);
        return { data: { session }, error: null };
      },
      async getUser() {
        calls.push({ method: 'getUser' });
        await pause(fixture.userDelay);
        return {
          data: { user: session?.user || null },
          error: fixture.userError ? { message: fixture.userError } : null,
        };
      },
      onAuthStateChange(callback) {
        listeners.add(callback);
        queueMicrotask(() => {
          if (listeners.has(callback)) callback('INITIAL_SESSION', session);
        });
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },
      async signInWithPassword() {
        // Do not record credentials, even the fake credentials used by tests.
        calls.push({ method: 'signInWithPassword' });
        await pause(fixture.loginDelay);
        if (fixture.loginError) {
          return { data: { user: null, session: null }, error: { message: fixture.loginError } };
        }
        session = { user };
        queueMicrotask(() => emit('SIGNED_IN', session));
        return { data: { user, session }, error: null };
      },
      async resetPasswordForEmail(email, { redirectTo }) {
        calls.push({ method: 'resetPasswordForEmail', redirectTo });
        return { data: {}, error: null };
      },
      async signOut() {
        calls.push({ method: 'signOut' });
        await pause(fixture.signOutDelay);
        if (fixture.signOutError) return { error: { message: fixture.signOutError } };
        emit('SIGNED_OUT', null);
        return { error: null };
      },
      async updateUser() {
        calls.push({ method: 'updateUser' });
        return { data: { user }, error: fixture.updateError ? { message: fixture.updateError } : null };
      },
    },
    rpc,
    from(table) {
      calls.push({ method: 'from', table });
      if (table !== 'profiles') throw new Error(`Unexpected skeleton database read: ${table}`);
      const query = {
        select() { return query; },
        eq() { return query; },
        single: profile,
        maybeSingle: profile,
      };
      return query;
    },
  };
}
