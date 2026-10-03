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
  removeItem("local", STORAGE_KEYS.agent);
  removeItem("local", STORAGE_KEYS.agentCredentials);
  removeItem("session", STORAGE_KEYS.agentCredentials);
}

export function clearAgent() {
  clearLegacyAgentCredentials();
  removeItem("local", STORAGE_KEYS.rememberedSession);
}

export function loadRememberedSession() {
  return readJson(STORAGE_KEYS.rememberedSession, null);
}

export function saveRememberedSession(session) {
  if (session?.token) {
    return writeJson(STORAGE_KEYS.rememberedSession, session);
  } else {
    removeItem("local", STORAGE_KEYS.rememberedSession);
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
  else removeItem("local", STORAGE_KEYS.pendingRevocations);
}

export function clearLegacyTours() {
  removeItem("local", STORAGE_KEYS.activeTour);
  removeItem("local", STORAGE_KEYS.tourHistory);
}

export function loadActiveTour() {
  return readJson(STORAGE_KEYS.activeTour, null);
}

export function saveActiveTour(tour) {
  if (!tour) {
    removeItem("local", STORAGE_KEYS.activeTour);
    return;
  }

  return writeJson(STORAGE_KEYS.activeTour, tour);
}

export function loadTourHistory() {
  const history = readJson(STORAGE_KEYS.tourHistory, []);
  return Array.isArray(history) ? history : [];
}

export function saveTourHistory(history) {
  return writeJson(STORAGE_KEYS.tourHistory, Array.isArray(history) ? history.slice(0, 25) : []);
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
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Storage parse failed for ${key}:`, error);
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`Storage write failed for ${key}:`, error);
    return false;
  }
}

function removeItem(area, key) {
  try {
    const storage = area === "session" ? sessionStorage : localStorage;
    storage.removeItem(key);
  } catch (error) {
    console.warn(`Storage cleanup failed for ${key}:`, error);
  }
}
