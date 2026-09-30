-- Enable pg_cron and pg_net in Supabase Database > Extensions before running this.
-- Add Vault secrets named project_url and service_role_key before scheduling.

select cron.unschedule(jobid)
from cron.job
where jobname = 'farley-send-alerts';

select cron.schedule(
  'farley-send-alerts',
  '* * * * *',
  $$
  select net.http_post(
    url := rtrim(
      (select decrypted_secret from vault.decrypted_secrets where name = 'project_url'),
      '/'
    ) || '/functions/v1/send-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);