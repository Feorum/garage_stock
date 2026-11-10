# Garage Daily Log (PWA + Supabase)

Mechanics log the work they did on each car; the administrator sees the same data with prices.
Prices live in a separate table that only admins can read (enforced by the database, not the screen).

Deployed app: https://feorum.github.io/garage_stock/

## Files
| File | Role |
|---|---|
| `index.html` | Page shell and styles |
| `app.js` | All app logic (login, mechanic view, admin view) |
| `account.html` + `account.js` | Secure email-link password setup and authenticated password changes |
| `sw.js` | Service worker: caches the app so it opens fast and offline |
| `manifest.webmanifest` + `icons/` | Makes it installable on a phone's home screen |
| `schema.sql` | Database tables, security rules, sample work list |

## Setup
1. **Create a Supabase project** at supabase.com (free tier is enough).
2. **Run the schema:** SQL Editor -> New query -> paste `schema.sql` -> Run.
3. **Lock sign-ups:** Authentication settings -> turn off "Allow new users to sign up" (you create accounts yourself).
4. **Create accounts:** Authentication -> Users -> Add user, one for you and one per mechanic (email + password, auto-confirm).
5. **Set names and your admin role** in the SQL Editor (replace the emails):
   ```sql
   update profiles set role = 'admin' where id = (select id from auth.users where email = 'you@example.com');
   update profiles set name = 'Andrey' where id = (select id from auth.users where email = 'andrey@example.com');
   update profiles set name = 'Fedor'  where id = (select id from auth.users where email = 'fedor@example.com');
   update profiles set name = 'John'   where id = (select id from auth.users where email = 'john@example.com');
   ```
6. **Build the public site:** set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or the legacy public `SUPABASE_ANON_KEY`) in your shell, then run `python3 scripts/build-pages.py`.
   Only public browser settings belong in this build. Never use a secret or `service_role` key. The output is in `dist/`.
7. **Test locally:** in this folder run `python3 -m http.server 8080 --directory dist`, open http://localhost:8080
   (service workers work on localhost without HTTPS).
8. **Deploy** the contents of `dist/` to a static host with HTTPS, such as GitHub Pages.
9. **Install on phones:** Android Chrome -> menu -> Install app. iPhone Safari -> Share -> Add to Home Screen.

## Check that prices are really hidden
Sign in as a mechanic, open the browser dev console and run:
`await sb.from('work_prices').select()` (or temporarily expose `sb`). It should return an empty list.

## Account setup emails

`account.html` accepts Supabase's implicit invitation/password-recovery callback. It verifies the session, removes authentication data from the address bar, and lets the user choose and confirm a password of at least 12 characters. Account pages and callback URLs bypass the service-worker cache.

Set Supabase Authentication's site URL to the deployed app and add the exact HTTPS `account.html` address to its redirect allowlist before sending emails. Existing confirmed users need a **password recovery/setup email**; the invitation endpoint rejects accounts that already exist. The email should redirect to `account.html`, and the page then links back to the garage log.

Supabase's default email service only sends to organization team members. Configure a custom SMTP sender for other recipients. For a small app, Gmail SMTP uses `smtp.gmail.com`, port `587`, the sender's Gmail address, and a Google app password. Keep the app password in secure settings, never in this repository or the public build.

The original schema is an initial migration: apply it once to a new database, not on every deployment.

## Ideas to learn next
- Daily email to the administrator: a Supabase Edge Function + `pg_cron` + an email service such as Resend.
- Offline queue: save entries in IndexedDB when there is no signal and sync later.
- Realtime: let the admin screen update live with `sb.channel(...)`.
- Cars and customers as their own tables instead of free text.
- When you change `app.js`, bump `CACHE` in `sw.js` (e.g. `garage-log-v2`) so phones pick up the update.
