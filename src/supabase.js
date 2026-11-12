import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// The build substitutes public browser settings here. No private key belongs in this module.
const SUPABASE_URL = "https://cjcevfdhzaemxqhhxtrt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_iCy4oYTjilzbUYXtI3M-rA_Pf-bHCGh";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true }
});
