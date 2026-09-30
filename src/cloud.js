const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
export const WEB_PUSH_PUBLIC_KEY = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY || "";
const SESSION_KEY = "farley:session";

export const cloudConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

function requireConfig() {
  if (!cloudConfigured) {
    throw new Error("Cloud sync is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
}

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setSession(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

async function request(path, options = {}) {
  requireConfig();
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const session = getSession();
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

  const response = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function refreshSessionIfNeeded() {
  const session = getSession();
  if (!session?.refresh_token) return null;
  if (session.expires_at && Date.now() < (session.expires_at - 60) * 1000) return session;

  try {
    const next = await request(`/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    const normalized = {
      ...session,
      ...next,
      user: next.user || session.user,
      expires_at: Math.floor(Date.now() / 1000) + (next.expires_in || 3600),
    };
    setSession(normalized);
    return normalized;
  } catch {
    setSession(null);
    return null;
  }
}

export async function getCurrentSession() {
  if (!cloudConfigured) return null;
  const session = await refreshSessionIfNeeded();
  if (!session?.access_token) return null;
  try {
    const user = await request("/auth/v1/user");
    return { session, user };
  } catch {
    setSession(null);
    return null;
  }
}

export async function signUp(email, password) {
  const data = await request("/auth/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (data?.access_token) {
    const session = {
      ...data,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    };
    setSession(session);
  }
  return data;
}

export async function signIn(email, password) {
  const data = await request("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const session = {
    ...data,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  setSession(session);
  return data;
}

export function signOut() {
  setSession(null);
}

export async function loadCloudData() {
  const session = await refreshSessionIfNeeded();
  if (!session?.access_token) return null;
  const rows = await request("/rest/v1/journal_data?select=trades,accounts,tags&limit=1");
  if (!rows?.length) return { trades: [], tags: [] };
  return {
    accounts: Array.isArray(rows[0].accounts) && rows[0].accounts.length
      ? rows[0].accounts
      : Array.isArray(rows[0].trades) && rows[0].trades.length
          ? [{ id: "account_default", name: "Main account", trades: rows[0].trades }]
          : [],
    tags: Array.isArray(rows[0].tags) ? rows[0].tags : [],
  };
}

export async function saveCloudData(accounts, tags) {
  const session = await refreshSessionIfNeeded();
  if (!session?.access_token) return;
  const userId = session.user?.id || session.user_id;
  if (!userId) throw new Error("Could not determine the signed-in user.");
  await request("/rest/v1/journal_data?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, accounts, trades: accounts[0]?.trades || [], tags }),
  });
}

export async function loadScheduledAlerts() {
  const rows = await request("/rest/v1/scheduled_alerts?select=id,title,starts_at,time_zone,repeat_type,next_fire_at&order=next_fire_at.asc.nullslast");
  return Array.isArray(rows) ? rows : [];
}

export async function saveScheduledAlert(alert) {
  const session = await refreshSessionIfNeeded();
  const userId = session?.user?.id || session?.user_id;
  if (!userId) throw new Error("Sign in to save push alerts.");
  return request("/rest/v1/scheduled_alerts?on_conflict=user_id,id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ ...alert, user_id: userId }),
  });
}

export async function deleteScheduledAlert(id) {
  return request(`/rest/v1/scheduled_alerts?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function savePushSubscription(subscription) {
  const session = await refreshSessionIfNeeded();
  const userId = session?.user?.id || session?.user_id;
  if (!userId) throw new Error("Sign in to enable push notifications.");
  return request("/rest/v1/push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, endpoint: subscription.endpoint, subscription }),
  });
}

export function getStoredSession() {
  return getSession();
}
