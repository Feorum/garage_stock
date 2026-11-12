import { createHandler } from './handler.ts';

// The gateway JWT check is disabled for this function because Managers have no
// application accounts. The handler and service-only RPC authenticate a source-
// scoped credential; no service-role credential leaves this runtime.
Deno.serve(createHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
}));
