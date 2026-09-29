export const STORAGE_KEYS = {
  agent: "security_patrol_agent",
  agentCredentials: "security_patrol_agent_credentials",
  activeTour: "security_patrol_active_tour",
  tourHistory: "security_patrol_tour_history"
};

export function clearAgent() {
  // Remove credentials saved by earlier releases. The PIN now lives only in memory.
  localStorage.removeItem(STORAGE_KEYS.agent);
  localStorage.removeItem(STORAGE_KEYS.agentCredentials);
  sessionStorage.removeItem(STORAGE_KEYS.agentCredentials);
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
