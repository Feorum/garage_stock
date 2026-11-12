// Browser-test fixture only. The public build does not include this module.
export function createClient() {
  const fixture = globalThis.__garageTest || {};
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
  const staff = clone(fixture.staff || [
    { id: user.id, name: 'Test Mechanic' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Other Mechanic' },
  ]);
  const receipts = new Map();
  const errorCounts = new Map();
  let serial = 0;
  let lostCreateResponse = false;
  const currentRole = () => (fixture.profile === undefined ? 'admin' : fixture.profile?.role);
  const errorResult = (message, code = 'P0001') => ({ data: null, error: { message, code } });
  const workName = code => ({ W01: 'капот полностью', W02: 'Бампер', W13: 'Зеркала', W19: 'тонировка задней полусферы (5%,15%)' }[code] || code);
  const taskVisible = task => task.assigned_to === user.id || task.working_mechanic_id === user.id;
  const visibleOrders = () => orders.flatMap(order => {
    if (currentRole() === 'admin' || order.source === 'manager') return [clone(order)];
    const tasks = order.tasks.filter(taskVisible);
    return tasks.length ? [{ ...clone(order), tasks: clone(tasks) }] : [];
  });
  globalThis.__garageOrderState = { orders, receipts, staff };

  async function rpc(name, args = {}) {
    calls.push({ method: 'rpc', name, args: clone(args) });
    await pause(fixture.rpcDelays?.[name] ?? fixture.rpcDelay);
    const configuredError = fixture.rpcErrors?.[name];
    if (configuredError) {
      const count = errorCounts.get(name) || 0;
      errorCounts.set(name, count + 1);
      if (typeof configuredError === 'string' || count < (configuredError.times || 1)) {
        return errorResult(typeof configuredError === 'string' ? configuredError : configuredError.message);
      }
    }
    if (!session) return errorResult('Sign in to continue.', '42501');
    const owner = currentRole() === 'admin';
    if (name === 'garage_list_orders') return { data: visibleOrders(), error: null };
    if (name === 'garage_staff') return owner ? { data: clone(staff), error: null } : errorResult('Owner access required.', '42501');
    if (name === 'garage_order_financials') {
      if (!owner) return errorResult('Owner access required.', '42501');
      return { data: clone(fixture.financials || { status: 'needs_pricing', currency: 'BYN', items: [], totals: null }), error: null };
    }
    const request = args.p_request_id;
    const fingerprint = JSON.stringify({ name, ...args });
    if (request && receipts.has(request)) {
      const receipt = receipts.get(request);
      return receipt.fingerprint === fingerprint ? clone(receipt.result) : errorResult('Request ID was already used for another action.');
    }
    let result;
    if (name === 'garage_create_order') {
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
          status: 'pending', assigned_to: task.assigned_to || null,
          assigned_name: staff.find(row => row.id === task.assigned_to)?.name || null,
          working_mechanic_id: null, working_name: null, blocker_reason: '', version: 1, completed_at: null,
        })),
      };
      orders.unshift(order);
      result = { data: clone(order), error: null };
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
      result = { data: clone(order), error: null };
    } else return errorResult(`Unexpected test RPC: ${name}`);
    if (request) receipts.set(request, { fingerprint, result: clone(result) });
    if (name === 'garage_create_order' && fixture.loseCreateResponseOnce && !lostCreateResponse) {
      lostCreateResponse = true;
      return errorResult('Network response was lost. Retry the same request.', 'NETWORK');
    }
    return result;
  }

  return {
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
