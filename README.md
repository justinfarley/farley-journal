# Farley Trades

A personal trading journal built with React/Vite.

## Cloud sync setup

The journal now stores trades and tags in Supabase so the same account can access them from every device. Local browser storage is kept as a cache and as a migration source for existing trades.

### 1. Create a Supabase project

Create a project at [supabase.com](https://supabase.com/) and open its SQL Editor.

### 2. Create the journal table

Run the contents of `supabase.sql` in the SQL Editor.

### 3. Add the Supabase config

Create `.env` from `.env.example`:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-SUPABASE-ANON-KEY
```

Use the project's public anon/publishable key, not a service-role key.

### 4. GitHub Pages deployment

Add these GitHub Actions repository secrets:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_WEB_PUSH_PUBLIC_KEY`

Then the existing Pages workflow can build the app with cloud sync enabled.

## iPhone background alerts

Background push requires iOS 16.4 or later, Farley Trades installed from Safari's **Add to Home Screen**, and notification permission. The app stores schedules in Supabase; Supabase Cron checks them every minute and sends Web Push. Delivery time can be delayed by iOS, network conditions, or power-saving behavior.

### 1. Apply the database schema

Run the updated `supabase.sql` in the Supabase SQL Editor. It adds owner-protected push subscriptions and scheduled alerts. If the journal tables already exist, rerunning the script is safe.

### 2. Generate VAPID keys

Run this once in a terminal and keep the private key secret:

```sh
npx --yes web-push generate-vapid-keys
```

Set `VITE_WEB_PUSH_PUBLIC_KEY` to the generated public key in your local `.env` and as a GitHub Actions repository secret. Do not put the private key in the frontend or GitHub Pages build.

### 3. Deploy the Supabase sender

Install and sign in to the Supabase CLI, then deploy the function (replace `PROJECT_REF` with the ref from your Supabase project URL):

```sh
supabase login
supabase link --project-ref PROJECT_REF
supabase secrets set VAPID_PUBLIC_KEY=YOUR_PUBLIC_KEY VAPID_PRIVATE_KEY=YOUR_PRIVATE_KEY VAPID_CONTACT=mailto:YOUR_EMAIL
```

Generate a separate random caller secret in PowerShell, then set it for the function:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$pushCronSecret = [Convert]::ToBase64String($bytes)
$rng.Dispose()
supabase secrets set "PUSH_CRON_SECRET=$pushCronSecret"
```

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function for database access. The function uses `PUSH_CRON_SECRET` to authenticate scheduled calls; keep both secrets private. Deploy after setting the secrets:

```sh
supabase functions deploy send-alerts
```

### 4. Schedule the sender

In Supabase, enable the `pg_cron`, `pg_net`, and Vault extensions. Create a Vault secret named `project_url` with your project URL, such as `https://PROJECT_REF.supabase.co`.

Create another Vault secret named `push_cron_secret` with the exact value of `$pushCronSecret`. You can create these in the Vault UI if available, or use SQL Editor. For SQL Editor, replace the placeholder, run this without saving the query, and do not share its contents:

```sql
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('YOUR_PUSH_CRON_SECRET', 'push_cron_secret');
```

Run `supabase/push_cron.sql` in the SQL Editor. It invokes the sender every minute using those Vault secrets. This dedicated secret avoids using the service-role key as the function's caller credential.

### 5. Build and enable on iPhone

Add `VITE_WEB_PUSH_PUBLIC_KEY` to GitHub Actions secrets, then redeploy the Pages site. On iPhone, open the site in Safari, choose **Share > Add to Home Screen**, and launch it from the new Home Screen icon. Sign in, open **Alerts**, tap **Enable push notifications**, and allow the iOS prompt. Create alerts after the device reports push is enabled.

### Existing local trades

When you first sign in on a device that already has locally stored trades, the app merges those trades into your cloud journal by trade ID. This prevents the first login from wiping the existing local journal.
