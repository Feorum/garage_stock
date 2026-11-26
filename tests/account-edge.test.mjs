import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/garage-accounts/handler.ts';

const url = 'https://garage.example.invalid', service = 'test-server-key', anon = 'test-public-key', token = 'owner-token';
const admin = '25029258-2333-47a2-b484-cf701eabdb6a', mechanic = '55aa4bc2-ab9b-4815-a76f-2da0d37ca847';
const email = 'test@example.invalid', password = 'synthetic-password-12';
const request = (body, accessToken) => new Request(url, { method: 'POST',
  headers: { 'content-type': 'application/json', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
  body: JSON.stringify(body) });

function setup(options = {}) {
  const calls = [];
  const fail = {};
  const handler = createHandler({ supabaseUrl:url, publicKey:anon, serviceRoleKey:service, fetchImpl: async (target,init) => {
    const address = new URL(target);
    const path = address.pathname, body = init.body ? JSON.parse(init.body) : null;
    const key = init.headers.get('apikey'), jwt = init.headers.get('Authorization');
    calls.push({path,body,key,jwt,method:init.method});
    // Store boundary failures to ensure the handler's safe error mapping does not swallow test assertions.
    try {
      assert.equal(address.origin,url); assert.equal(init.redirect,'error');
      if (path.endsWith('garage_resolve_login_name')) {
        assert.equal(key,service); assert.equal(jwt,'Bearer ' + service);
        return Response.json(options.missing ? null : email);
      }
      if (path === '/auth/v1/token') {
        assert.equal(address.search,'?grant_type=password'); assert.equal(key,anon); assert.equal(jwt,null);
        return Response.json(options.authError ? {message:email} :
          {access_token:'verified',refresh_token:'refresh',user:{id:mechanic,email}}, {status:options.authError || 200});
      }
      if (path === '/auth/v1/user') {
        assert.equal(key,anon); assert.equal(jwt,'Bearer ' + token);
        return Response.json({id:admin},{status:options.verifyError || 200});
      }
      if (path === '/rest/v1/profiles') {
        assert.equal(key,anon); assert.ok(jwt === 'Bearer verified' || jwt === 'Bearer ' + token);
        const id = address.searchParams.get('id').slice(3);
        return Response.json([{id,active:id === admin ? !options.ownerDisabled : !options.targetDisabled,
          role:id === admin ? options.ownerRole || 'admin' : options.targetRole || 'mechanic'}]);
      }
      if (path.endsWith('garage_mechanic_accounts')) {
        assert.equal(key,anon); assert.equal(jwt,'Bearer ' + token);
        return Response.json([{id:mechanic,name:'Иван',email,role:'mechanic',active:true,color:null,secret:'private'}]);
      }
      if (path.startsWith('/auth/v1/admin/users')) {
        assert.equal(key,service); assert.equal(jwt,'Bearer ' + service);
        return options.duplicate ? Response.json({error_code:'email_exists',message:email},{status:422}) :
          Response.json({id:mechanic,email,private:'hidden'});
      }
      throw Error('Unexpected upstream ' + path);
    } catch (error) { fail.error = error; throw error; }
  } });
  const send = async (body, bearer) => {
    const res = await handler(request(body,bearer));
    if (fail.error) throw fail.error;
    return res;
  };
  return {handler,send,calls};
}

const signin = {action:'login',identifier:'  Иван  ',password};
test('a verified password for an active profile yields only tokens', async () => {
  const {send,calls} = setup();
  const res = await send(signin);
  assert.equal(res.status,200); assert.deepEqual(await res.json(),{access_token:'verified',refresh_token:'refresh'});
  assert.deepEqual(calls.map(c=>c.path),['/rest/v1/rpc/garage_resolve_login_name','/auth/v1/token','/rest/v1/profiles']);
  assert.deepEqual(calls[0].body,{p_name:'Иван'}); assert.deepEqual(calls[1].body,{email,password});
  const direct = setup();
  assert.equal((await direct.send({...signin,identifier:email})).status,200);
  assert.equal(direct.calls[0].path,'/auth/v1/token');
});

test('unknown names, wrong passwords and inactive accounts receive identical failures', async () => {
  const missing = setup({missing:true});
  const responses = await Promise.all([missing.send(signin),setup({authError:400}).send(signin),setup({targetDisabled:true}).send(signin)]);
  assert.deepEqual(responses.map(r=>r.status),[401,401,401]);
  const texts = await Promise.all(responses.map(r=>r.text()));
  assert.equal(new Set(texts).size,1); assert.ok(!texts[0].includes(email));
  assert.equal(missing.calls[1].path,'/auth/v1/token'); assert.match(missing.calls[1].body.email,/@account\.invalid$/);
  assert.equal((await setup({missing:true,authError:429}).send(signin)).status,429);
});

test('only an active verified owner reads a minimal mechanic directory', async () => {
  for (const [options,bearer,status] of [[{},null,401],[{},anon,401],[{},service,401],
    [{verifyError:401},token,401],[{ownerDisabled:true},token,403],[{ownerRole:'mechanic'},token,403]]) {
    const {send,calls} = setup(options);
    assert.equal((await send({action:'list'},bearer)).status,status);
    assert.ok(!calls.some(c=>c.path.endsWith('garage_mechanic_accounts')));
  }
  const {send} = setup();
  assert.deepEqual(await (await send({action:'list'},token)).json(),{accounts:[
    {id:mechanic,name:'Иван',email,role:'mechanic',active:true,color:null}
  ]});
});

test('creating a mechanic uses a single admin write and the database profile trigger', async () => {
  const body = {action:'create',name:'  Иван  Петров  ',email,password};
  const {send,calls} = setup({missing:true});
  assert.deepEqual(await (await send(body,token)).json(),{id:mechanic});
  assert.deepEqual(calls.at(-1).body,{email,password,email_confirm:true,user_metadata:{name:'Иван Петров'}});
  assert.equal(calls.at(-1).method,'POST');
  assert.equal((await setup().send(body,token)).status,409);
  assert.equal((await setup({missing:true,duplicate:true}).send(body,token)).status,409);
  for (const mod of [{role:'admin'},{password:'short'},{password:'ж'.repeat(37)},{name:'name@example.invalid'}]) {
    const {send,calls} = setup({missing:true});
    assert.equal((await send({...body,...mod},token)).status,400);
    assert.ok(!calls.some(c=>c.path.startsWith('/auth/v1/admin/users')));
  }
});

test('updates require an existing active mechanic distinct from the owner', async () => {
  for (const [id,options] of [[admin,{}],[mechanic,{targetDisabled:true}],[mechanic,{targetRole:'admin'}]]) {
    const {send,calls} = setup(options);
    assert.equal((await send({action:'update',id,password},token)).status,403);
    assert.ok(!calls.some(c=>c.path.startsWith('/auth/v1/admin/users')));
  }
  const {send,calls} = setup();
  assert.equal((await send({action:'update',id:mechanic,password},token)).status,200);
  assert.equal(calls.at(-1).path,'/auth/v1/admin/users/' + mechanic);
  assert.deepEqual(calls.at(-1).body,{password}); assert.equal(calls.at(-1).method,'PUT');
  assert.equal((await send({action:'update',id:mechanic,email},token)).status,200);
  assert.deepEqual(calls.at(-1).body,{email,email_confirm:true});
  assert.equal((await send({action:'update',id:mechanic},token)).status,400);
});

test('public CORS preflight and request size validation do not touch accounts', async () => {
  const {handler,send,calls} = setup();
  const preflight = await handler(new Request(url,{method:'OPTIONS'}));
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'*');
  assert.equal((await send({...signin,password:'a'.repeat(9000)})).status,400);
  assert.equal(calls.length,0);
});
