type Dependencies = {
  supabaseUrl: string;
  publicKey: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
};

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const maxBody = 8192;
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const errors = {
  invalid_request: [400, 'Проверьте введённые данные.'],
  invalid_credentials: [401, 'Неверное имя, почта или пароль.'],
  sign_in_required: [401, 'Войдите в учётную запись.'],
  owner_required: [403, 'Управление аккаунтами доступно владельцу.'],
  invalid_target: [403, 'Доступ можно изменить только для активного механика.'],
  name_taken: [409, 'Это имя уже используется.'],
  email_taken: [409, 'Эта почта уже используется.'],
  password_rejected: [400, 'Введите пароль не короче 12 символов, длиной до 72 байт.'],
  create_failed: [503, 'Не удалось создать аккаунт. Проверьте, свободны ли имя и почта, и повторите попытку.'],
  rate_limited: [429, 'Слишком много попыток. Повторите позже.'],
  unavailable: [503, 'Не удалось связаться со службой аккаунтов. Повторите позже.'],
} as const;

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}
function failure(code: keyof typeof errors) {
  const [status, error] = errors[code];
  return reply({ code, error }, status);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function only(body: Record<string, unknown>, allowed: string[]) {
  return Object.keys(body).every(key => key === 'action' || allowed.includes(key));
}
function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length <= 254 && emailPattern.test(value.trim());
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && [...value].length >= 12 && new TextEncoder().encode(value).length <= 72;
}

async function readInput(request: Request) {
  if (!request.body || Number(request.headers.get('content-length')) > maxBody) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBody) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function createHandler({ supabaseUrl, publicKey, serviceRoleKey, fetchImpl = fetch }: Dependencies) {
  const origin = new URL(supabaseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || !publicKey || !serviceRoleKey || publicKey === serviceRoleKey) {
    throw new Error('Invalid account service configuration');
  }

  async function call(path: string, key: string, token?: string, method = 'GET', body?: unknown) {
    const h = new Headers({ apikey: key, 'Content-Type': 'application/json' });
    if (token) h.set('Authorization', 'Bearer ' + token);
    const res = await fetchImpl(origin.origin + path, { method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(12000) });
    const data: unknown = await res.json().catch(() => null);
    return { res, data };
  }
  function resolveName(name: string) {
    return call('/rest/v1/rpc/garage_resolve_login_name', serviceRoleKey, serviceRoleKey, 'POST', { p_name: name });
  }
  async function profileFor(id: string, token: string) {
    const { data, res } = await call('/rest/v1/profiles?select=id,role,active&id=eq.' + id, publicKey, token);
    if (!res.ok) throw new Error('Profile unavailable');
    return Array.isArray(data) && data.length === 1 && data[0]?.id === id ? data[0] : null;
  }

  async function login(body: Record<string, unknown>) {
    if (!only(body, ['identifier', 'password']) || typeof body.identifier !== 'string' ||
        typeof body.password !== 'string' || !body.password || !body.identifier.trim()) return failure('invalid_credentials');
    const identifier = body.identifier.trim();
    const name = identifier.normalize('NFC').replace(/\s+/gu, ' ');
    let email: string | null = null;
    if (identifier.includes('@')) {
      if (validEmail(identifier)) email = identifier;
    } else if ([...name].length <= 120) {
      const found = await resolveName(name);
      if (!found.res.ok) return failure('unavailable');
      if (validEmail(found.data)) email = found.data;
    }

    // All nonempty attempts, including missing/ambiguous names, use the same public
    // GoTrue password grant and its IP rate limit. Never trust caller-supplied IP headers.
    const { data, res } = await call('/auth/v1/token?grant_type=password', publicKey, undefined, 'POST', {
      email: email ?? 'unknown-' + crypto.randomUUID() + '@account.invalid', password: body.password,
    });
    if (res.status === 429) return failure('rate_limited');
    if (res.status >= 500) return failure('unavailable');
    if (!email || !res.ok || !object(data) || typeof data.access_token !== 'string' || !data.access_token ||
        typeof data.refresh_token !== 'string' || !data.refresh_token || !object(data.user) ||
        typeof data.user.id !== 'string' || !uuid.test(data.user.id)) return failure('invalid_credentials');
    const profile = await profileFor(data.user.id, data.access_token);
    if (profile?.active !== true || !['admin', 'mechanic'].includes(profile.role)) return failure('invalid_credentials');
    return reply({ access_token: data.access_token, refresh_token: data.refresh_token });
  }

  async function adminWrite(path: string, method: string, fields: Record<string, unknown>) {
    const { res, data } = await call(path, serviceRoleKey, serviceRoleKey, method, fields);
    if (res.ok && object(data) && typeof data.id === 'string' && uuid.test(data.id)) return reply({ id: data.id });
    const code = object(data) ? data.error_code ?? data.code : null;
    if (code === 'email_exists' || code === 'user_already_exists') return failure('email_taken');
    if (code === 'weak_password') return failure('password_rejected');
    if (code === 'user_not_found') return failure('invalid_target');
    if (res.status === 429) return failure('rate_limited');
    // GoTrue may report a profile trigger rejection as a generic server error.
    if (method === 'POST' && res.status >= 500) return failure('create_failed');
    return failure(res.status >= 500 || res.ok ? 'unavailable' : 'invalid_request');
  }

  return async (request: Request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply({ code: 'invalid_method', error: 'Используйте POST.' }, 405);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || new URL(request.url).search) {
      return failure('invalid_request');
    }
    const body = await readInput(request);
    if (!object(body)) return failure('invalid_request');
    try {
      if (body.action === 'login') return await login(body);
      if (typeof body.action !== 'string' || !['list', 'create', 'update'].includes(body.action)) return failure('invalid_request');

      // GET /auth/v1/user is the Auth server verification performed by auth.getUser(token).
      // Use the caller's JWT for both permission checks and all directory/profile reads.
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get('authorization') || '')?.[1];
      if (!token || token === serviceRoleKey || token === publicKey) return failure('sign_in_required');
      const verifier = await call('/auth/v1/user', publicKey, token);
      if (verifier.res.status >= 500) return failure('unavailable');
      if (!verifier.res.ok || !object(verifier.data) || typeof verifier.data.id !== 'string' ||
          !uuid.test(verifier.data.id)) return failure('sign_in_required');
      const owner = await profileFor(verifier.data.id, token);
      if (owner?.active !== true || owner.role !== 'admin') return failure('owner_required');

      if (body.action === 'list') {
        if (!only(body, [])) return failure('invalid_request');
        const { res, data } = await call('/rest/v1/rpc/garage_mechanic_accounts', publicKey, token, 'POST', {});
        if (!res.ok || !Array.isArray(data)) return failure('unavailable');
        const accounts = data.filter(row => row?.role === 'mechanic').map(({ id, name, email, role, active, color }) =>
          ({ id, name, email, role, active, color }));
        return reply({ accounts });
      }
      const creating = body.action === 'create';
      if (!only(body, creating ? ['name', 'email', 'password'] : ['id', 'email', 'password'])) return failure('invalid_request');
      if ((creating || 'email' in body) && !validEmail(body.email)) return failure('invalid_request');
      if ((creating || 'password' in body) && !validPassword(body.password)) return failure('password_rejected');
      const fields: Record<string, unknown> = {};
      if (typeof body.email === 'string') { fields.email = body.email.trim(); fields.email_confirm = true; }
      if (typeof body.password === 'string') fields.password = body.password;
      if (creating) {
        const name = typeof body.name === 'string' ? body.name.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
        if (!name || [...name].length > 120 || /[@\p{Cc}]/u.test(name)) return failure('invalid_request');
        const existing = await resolveName(name);
        if (!existing.res.ok) return failure('unavailable');
        if (existing.data != null) return failure('name_taken');
        // The profile trigger creates a mechanic and enforces name uniqueness within the Auth insert.
        return await adminWrite('/auth/v1/admin/users', 'POST', { ...fields, user_metadata: { name } });
      }
      if (typeof body.id !== 'string' || !uuid.test(body.id) || !Object.keys(fields).length) return failure('invalid_request');
      if (body.id.toLowerCase() === owner.id.toLowerCase()) return failure('invalid_target');
      const target = await profileFor(body.id.toLowerCase(), token);
      if (target?.active !== true || target.role !== 'mechanic') return failure('invalid_target');
      return await adminWrite('/auth/v1/admin/users/' + target.id, 'PUT', fields);
    } catch {
      // Upstream messages can contain account details. Do not log or return them.
      return failure('unavailable');
    }
  };
}
