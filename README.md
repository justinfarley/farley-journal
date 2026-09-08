# Farley Trades

A personal trading journal built with React/Vite.

## Cloud sync setup

The journal now stores trades and tags in Supabase so the same account can access them from every device. Local browser storage is kept as a cache and as a migration source for existing trades.

### 1. Create a Supabase project

Create a project at https://supabase.com/ and open its SQL Editor.

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

Then the existing Pages workflow can build the app with cloud sync enabled.

### Existing local trades

When you first sign in on a device that already has locally stored trades, the app merges those trades into your cloud journal by trade ID. This prevents the first login from wiping the existing local journal.
