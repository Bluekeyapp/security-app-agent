export const STORAGE_KEYS = {
  agent: "security_patrol_agent",
  agentCredentials: "security_patrol_agent_credentials",
  rememberedSession: "security_patrol_remembered_session",
  pendingRevocations: "security_patrol_pending_revocations",
  activeTour: "security_patrol_active_tour",
  tourHistory: "security_patrol_tour_history"
};

export function clearLegacyAgentCredentials() {
  // Remove credentials saved by earlier releases. The PIN now lives only in memory.
  localStorage.removeItem(STORAGE_KEYS.agent);
  localStorage.removeItem(STORAGE_KEYS.agentCredentials);
  sessionStorage.removeItem(STORAGE_KEYS.agentCredentials);
}

export function clearAgent() {
  clearLegacyAgentCredentials();
  localStorage.removeItem(STORAGE_KEYS.rememberedSession);
}

export function loadRememberedSession() {
  return readJson(STORAGE_KEYS.rememberedSession, null);
}

export function saveRememberedSession(session) {
  if (session?.token) {
    writeJson(STORAGE_KEYS.rememberedSession, session);
  } else {
    localStorage.removeItem(STORAGE_KEYS.rememberedSession);
  }
}

export function queueSessionRevocation(token) {
  if (!token) return;
  const pending = readJson(STORAGE_KEYS.pendingRevocations, []);
  writeJson(STORAGE_KEYS.pendingRevocations, [...new Set([...(Array.isArray(pending) ? pending : []), token])]);
}

export function loadPendingRevocations() {
  const pending = readJson(STORAGE_KEYS.pendingRevocations, []);
  return Array.isArray(pending) ? pending : [];
}

export function clearPendingRevocation(token) {
  const remaining = loadPendingRevocations().filter((item) => item !== token);
  if (remaining.length) writeJson(STORAGE_KEYS.pendingRevocations, remaining);
  else localStorage.removeItem(STORAGE_KEYS.pendingRevocations);
}

export function clearAgentWorkspace() {
  clearAgent();
  localStorage.removeItem(STORAGE_KEYS.activeTour);
  localStorage.removeItem(STORAGE_KEYS.tourHistory);
}

export function loadActiveTour() {
  return readJson(STORAGE_KEYS.activeTour, null);
}

export function saveActiveTour(tour) {
  if (!tour) {
    localStorage.removeItem(STORAGE_KEYS.activeTour);
    return;
  }

  writeJson(STORAGE_KEYS.activeTour, tour);
}

export function loadTourHistory() {
  const history = readJson(STORAGE_KEYS.tourHistory, []);
  return Array.isArray(history) ? history : [];
}

export function saveTourHistory(history) {
  writeJson(STORAGE_KEYS.tourHistory, Array.isArray(history) ? history.slice(0, 25) : []);
}

export function addTourToHistory(tour) {
  const history = loadTourHistory();
  saveTourHistory([tour, ...history].slice(0, 25));
}

export function replaceTourInHistory(tour) {
  if (!tour?.id) {
    return;
  }

  const history = loadTourHistory();
  saveTourHistory([tour, ...history.filter((item) => item.id !== tour.id)].slice(0, 25));
}

function readJson(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Storage parse failed for ${key}:`, error);
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
