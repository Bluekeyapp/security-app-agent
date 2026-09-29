import { getSupabaseClient } from "./supabaseClient.js";

export async function authenticateAgent({ badge, pin, remember = false }) {
  const supabase = await getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: new Error("Supabase non configuré") };
  }

  const { data, error } = await supabase.rpc(remember ? "create_remembered_agent_session" : "authenticate_agent_session", {
    p_badge: String(badge || "").trim(),
    p_pin: String(pin || "")
  });
  const agent = remember ? data : (Array.isArray(data) ? data[0] : null);

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
    sessionEpoch: agent.session_epoch,
    token: remember ? agent.token : null
  };
}

export async function resumeRememberedAgent(token) {
  const supabase = await getSupabaseClient();
  if (!supabase || !token) return { ok: false };
  const { data, error } = await supabase.rpc("resume_remembered_agent_session", { p_token: token });
  if (error) return { ok: false, error };
  if (!data) return { ok: false, invalidCredentials: true };
  return {
    ok: true,
    agent: { id: data.id, name: data.name, badge: data.badge, siteId: data.site_id, siteName: data.site_name },
    token
  };
}

export async function revokeRememberedAgent(token) {
  const supabase = await getSupabaseClient();
  if (!supabase || !token) return false;
  try {
    const { error } = await supabase.rpc("revoke_remembered_agent_session", { p_token: token });
    return !error;
  } catch {
    return false;
  }
}

export async function fetchAgentRoutes(credentials) {
  const supabase = await getSupabaseClient();
  if (!supabase || (!credentials?.token && (!credentials?.badge || !credentials?.pin))) {
    return { ok: false, error: new Error("Site non configuré") };
  }

  const { data, error } = credentials.token
    ? await supabase.rpc("get_agent_routes_token", { p_token: credentials.token })
    : await supabase.rpc("get_agent_routes_session", {
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
  if (!supabase || !tour || (!credentials?.token && (!credentials?.badge || !credentials?.pin))) {
    return { ok: false, skipped: true };
  }

  const { error } = credentials.token
    ? await supabase.rpc("sync_agent_tour_token", { p_token: credentials.token, p_tour: tour })
    : await supabase.rpc("sync_agent_tour_session", {
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
  if (!supabase || (!credentials?.token && (!credentials?.badge || !credentials?.pin || !credentials?.sessionEpoch))) {
    return { ok: false, valid: false };
  }

  const { data, error } = credentials.token
    ? await supabase.rpc("resume_remembered_agent_session", { p_token: credentials.token })
    : await supabase.rpc("check_agent_session", {
      p_badge: credentials.badge,
      p_pin: credentials.pin,
      p_session_epoch: credentials.sessionEpoch
    });

  return error
    ? { ok: false, valid: false, error }
    : { ok: true, valid: credentials.token ? Boolean(data) : data === true };
}
