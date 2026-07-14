// Supabase Edge Function: delete-account
//
// Permanently deletes the calling user's account and all associated data:
// their `public.lists` rows, their `public.shop` row, their
// `public.profiles` row (if any), and finally their `auth.users` record.
//
// The auth user is deleted LAST, on purpose: if any data-deletion step
// fails, the user's login still exists, so they can sign back in and retry
// instead of being locked out with orphaned data and no way back in.
//
// Required secrets (Supabase Dashboard -> Edge Functions -> delete-account
// -> Settings -> Secrets, or `supabase secrets set NAME=value` via the CLI):
//   SUPABASE_URL               - this project's URL. The Supabase runtime
//                                 injects this automatically; only add it
//                                 by hand if that's ever not the case.
//   SUPABASE_SERVICE_ROLE_KEY  - the service_role key from
//                                 Project Settings -> API. NEVER the anon
//                                 key, and NEVER committed to the repo or
//                                 used in front-end code.
//
// Deploy via the Supabase Dashboard: Edge Functions -> Create a function ->
// name it exactly "delete-account" -> paste this file's contents -> Deploy.
// Then add the SUPABASE_SERVICE_ROLE_KEY secret under that function's
// Settings. index.html calls this at
// `${SUPABASE_URL}/functions/v1/delete-account` automatically — as long as
// the function is named exactly this, no front-end changes are needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('delete-account: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Derive the caller's user id from their own JWT server-side — never
  // trust a user id passed in the request body.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: 'Invalid or expired session' }, 401);
  }
  const userId = userData.user.id;

  const { error: listsErr } = await admin.from('lists').delete().eq('user_id', userId);
  if (listsErr) {
    console.error('delete-account: failed to delete lists for', userId, listsErr);
    return jsonResponse({ error: 'Failed to delete saved lists — nothing was deleted, please retry' }, 500);
  }

  const { error: shopErr } = await admin.from('shop').delete().eq('user_id', userId);
  if (shopErr) {
    console.error('delete-account: failed to delete shop row for', userId, shopErr);
    return jsonResponse({ error: 'Failed to delete shop data — please retry' }, 500);
  }

  const { error: hoursErr } = await admin.from('hours').delete().eq('user_id', userId);
  if (hoursErr) {
    console.error('delete-account: failed to delete hours row for', userId, hoursErr);
    return jsonResponse({ error: 'Failed to delete hours data — please retry' }, 500);
  }

  const { error: projectsErr } = await admin.from('projects').delete().eq('user_id', userId);
  if (projectsErr) {
    console.error('delete-account: failed to delete projects for', userId, projectsErr);
    return jsonResponse({ error: 'Failed to delete projects — please retry' }, 500);
  }

  // DELETE matching zero rows is not an error, so this is a no-op (not a
  // failure) for accounts that never had a profiles row.
  const { error: profileErr } = await admin.from('profiles').delete().eq('id', userId);
  if (profileErr) {
    console.error('delete-account: failed to delete profile row for', userId, profileErr);
    return jsonResponse({ error: 'Failed to delete profile — please retry' }, 500);
  }

  const { error: deleteUserErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteUserErr) {
    console.error('delete-account: failed to delete auth user', userId, deleteUserErr);
    return jsonResponse({ error: 'Your data was removed but your login could not be deleted — please retry or contact support' }, 500);
  }

  return jsonResponse({ success: true }, 200);
});
