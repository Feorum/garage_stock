import { createPullHandler } from './handler.ts';

Deno.serve(createPullHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  schedulerSecret: Deno.env.get('GARAGE_SHEET_PULL_SCHEDULER_SECRET') || ''
}));
