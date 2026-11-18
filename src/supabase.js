import { createClient } from '@supabase/supabase-js';

// Vite substitutes only the validated public settings into this browser adapter.
export const publicApiOrigin = __GARAGE_SUPABASE_URL__;
export const sb = createClient(publicApiOrigin, __GARAGE_PUBLIC_KEY__, {
  auth: { flowType: 'implicit', detectSessionInUrl: true },
});
