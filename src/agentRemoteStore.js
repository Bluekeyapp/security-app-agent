import { getSupabaseClient } from "./supabaseClient.js";

export async function authenticateAgent({ badge, pin }) {
  const supabase = await getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: new Error("Supabase non configuré") };
  }

  const { data, error } = await supabase.rpc("authenticate_agent_session", {
    p_badge: String(badge || "").trim(),
    p_pin: String(pin || "")
  });
  const agent = Array.isArray(data) ? data[0] : null;

  if (error) return { ok: false, error };
  if (!agent) return { ok: false, invalidCredentials: true };

  return {
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      badge: agent.badge,
      siteId: agent.site_id,
      siteName: agent.site_name
    },
    sessionEpoch: agent.session_epoch
  };
}

export async function fetchAgentRoutes(credentials) {
  const supabase = await getSupabaseClient();
  if (!supabase || !credentials?.badge || !credentials?.pin) {
    return { ok: false, error: new Error("Site non configuré") };
  }

  const { data, error } = await supabase.rpc("get_agent_routes_session", {
    p_badge: credentials.badge,
    p_pin: credentials.pin,
    p_session_epoch: credentials.sessionEpoch
  });
  const routes = Array.isArray(data)
    ? data.filter((route) => route.points?.some((point) => point.kind === "start"))
    : [];

  return error ? { ok: false, error, routes: [] } : { ok: true, routes };
}

export async function saveTourRemote(tour, credentials) {
  const supabase = await getSupabaseClient();
  if (!supabase || !tour || !credentials?.badge || !credentials?.pin) {
    return { ok: false, skipped: true };
  }

  const { error } = await supabase.rpc("sync_agent_tour_session", {
    p_badge: credentials.badge,
    p_pin: credentials.pin,
    p_session_epoch: credentials.sessionEpoch,
    p_tour: tour
  });

  return error
    ? { ok: false, error, authRejected: error.code === "28000" }
    : { ok: true };
}

export async function checkAgentSession(credentials) {
  const supabase = await getSupabaseClient();
  if (!supabase || !credentials?.badge || !credentials?.pin || !credentials?.sessionEpoch) {
    return { ok: false, valid: false };
  }

  const { data, error } = await supabase.rpc("check_agent_session", {
    p_badge: credentials.badge,
    p_pin: credentials.pin,
    p_session_epoch: credentials.sessionEpoch
  });

  return error
    ? { ok: false, valid: false, error }
    : { ok: true, valid: data === true };
}
