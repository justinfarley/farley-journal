import webpush from "npm:web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidContact = Deno.env.get("VAPID_CONTACT");

type ScheduledAlert = {
  user_id: string;
  id: string;
  title: string;
  time_zone: string;
  repeat_type: "once" | "daily" | "weekdays" | "weekly";
  next_fire_at: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatInZone(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, number>>((parts, item) => {
    if (item.type !== "literal") parts[item.type] = Number(item.value);
    return parts;
  }, {});
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

function localTimeToUtc(parts: ReturnType<typeof formatInZone>, timeZone: string) {
  const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = new Date(wanted);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = formatInZone(candidate, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const adjustment = wanted - represented;
    if (adjustment === 0) return candidate;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}

function nextOccurrence(alert: ScheduledAlert, now: Date) {
  if (alert.repeat_type === "once") return null;
  const timeZone = alert.time_zone || "UTC";
  const current = formatInZone(new Date(alert.next_fire_at), timeZone);
  let dayOffset = alert.repeat_type === "weekly" ? 7 : 1;
  let candidate: Date;

  for (let attempt = 0; attempt < 370; attempt += 1) {
    const calendarDate = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
    const parts = {
      year: calendarDate.getUTCFullYear(),
      month: calendarDate.getUTCMonth() + 1,
      day: calendarDate.getUTCDate(),
      hour: current.hour,
      minute: current.minute,
    };
    if (alert.repeat_type === "weekdays") {
      const weekday = calendarDate.getUTCDay();
      if (weekday === 0 || weekday === 6) {
        dayOffset += 1;
        continue;
      }
    }
    candidate = localTimeToUtc(parts, timeZone);
    if (candidate.getTime() > now.getTime()) return candidate.toISOString();
    dayOffset += alert.repeat_type === "weekly" ? 7 : 1;
  }
  throw new Error(`Could not find next occurrence for alert ${alert.id}`);
}

async function databaseRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${responseText}`);
  return responseText ? JSON.parse(responseText) : null;
}

async function updateAlert(alert: ScheduledAlert, patch: Record<string, unknown>) {
  const query = new URLSearchParams({ user_id: `eq.${alert.user_id}`, id: `eq.${alert.id}` });
  await databaseRequest(`scheduled_alerts?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

async function removeSubscription(endpoint: string) {
  const query = new URLSearchParams({ endpoint: `eq.${endpoint}` });
  await databaseRequest(`push_subscriptions?${query}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

Deno.serve(async (request) => {
  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey || !vapidContact) {
    return jsonResponse({ error: "Push sender environment is incomplete." }, 500);
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
  if (request.headers.get("authorization") !== `Bearer ${serviceRoleKey}`) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  webpush.setVapidDetails(vapidContact, vapidPublicKey, vapidPrivateKey);
  try {
    const alerts = await databaseRequest("rpc/claim_due_push_alerts", { method: "POST", body: "{}" }) as ScheduledAlert[];
    let sent = 0;
    let failed = 0;

    for (const alert of alerts || []) {
      const subscriptionQuery = new URLSearchParams({
        select: "subscription",
        user_id: `eq.${alert.user_id}`,
      });
      const subscriptions = await databaseRequest(`push_subscriptions?${subscriptionQuery}`) as Array<{
        subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
      }>;
      let delivered = subscriptions.length === 0;

      for (const row of subscriptions) {
        try {
          await webpush.sendNotification(row.subscription, JSON.stringify({
            title: "Farley Trades",
            body: alert.title,
            tag: `farley-${alert.id}`,
          }), { TTL: 3600, urgency: "high" });
          delivered = true;
          sent += 1;
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await removeSubscription(row.subscription.endpoint);
          } else {
            console.error(`Push delivery failed for alert ${alert.id}:`, error);
          }
        }
      }

      if (delivered) {
        const nextFireAt = nextOccurrence(alert, new Date());
        await updateAlert(alert, {
          next_fire_at: nextFireAt,
          claim_until: null,
          last_sent_at: new Date().toISOString(),
        });
      } else {
        await updateAlert(alert, { claim_until: null });
        failed += 1;
      }
    }

    return jsonResponse({ claimed: alerts?.length || 0, sent, failed });
  } catch (error) {
    console.error("Scheduled push run failed:", error);
    return jsonResponse({ error: "Scheduled push run failed." }, 500);
  }
});