import {
  CANCEL_SUGGESTIONS,
  addTourIncident,
  applyScan,
  cancelTour,
  getClosingScan,
  findRouteForStartPayload,
  getPointProgress,
  getRouteCheckpointIds,
  getScannedCheckpointIds,
  getTourPhase,
  setTourComment,
  startTour
} from "./patrol.js";
import {
  clearAgent,
  clearPendingRevocation,
  clearLegacyAgentCredentials,
  clearLegacyTours,
  loadPendingRevocations,
  loadRememberedSession,
  loadActiveTour,
  loadTourHistory,
  queueSessionRevocation,
  saveRememberedSession
} from "./storage.js?v=64";
import { authenticateAgent, checkAgentSession, fetchAgentRoutes, resumeRememberedAgent, revokeRememberedAgent, saveTourRemote } from "./agentRemoteStore.js?v=67";
import { migrateLegacyTours, tourStore } from "./tourStore.js?v=1";
import { createTourSync, selectAgentTours } from "./tourSync.js?v=1";

// Clear PINs persisted by older versions before rendering or accepting input.
clearLegacyAgentCredentials();

const state = {
  restoringSession: false,
  agent: null,
  credentials: null,
  activeTour: null,
  history: [],
  syncStatus: "",
  session: null,
  routes: [],
  route: null,
  pendingStart: false,
  commentTour: null,
  lastOutcomeTour: null,
  scannerOpen: false,
  cancelOpen: false,
  selectedCancelReason: "",
  incidentOpen: false
};

const scanner = {
  detector: null,
  zxingModule: null,
  zxingReader: null,
  zxingControls: null,
  stream: null,
  loopId: null,
  locked: false,
  starting: false,
  armedAt: 0,
  locationPromise: null
};

const dom = {
  viewportMeta: document.querySelector('meta[name="viewport"]'),
  mainView: document.getElementById("mainView"),
  syncStatus: document.getElementById("syncStatus"),
  signOutButton: document.getElementById("signOutButton"),

  toast: document.getElementById("toast"),
  scannerSheet: document.getElementById("scannerSheet"),
  closeScannerButton: document.getElementById("closeScannerButton"),
  scannerTitle: document.getElementById("scannerTitle"),
  scannerVideo: document.getElementById("scannerVideo"),
  cameraState: document.getElementById("cameraState"),
  startCameraButton: document.getElementById("startCameraButton"),
  cancelSheet: document.getElementById("cancelSheet"),
  closeCancelButton: document.getElementById("closeCancelButton"),
  cancelReason: document.getElementById("cancelReason"),
  confirmCancelButton: document.getElementById("confirmCancelButton"),
  incidentSheet: document.getElementById("incidentSheet"),
  closeIncidentButton: document.getElementById("closeIncidentButton"),
  incidentForm: document.getElementById("incidentForm"),
  incidentNote: document.getElementById("incidentNote"),
  incidentPhoto: document.getElementById("incidentPhoto")
};

let toastTimer = null;
let sessionMonitorId = null;
let sessionCheckInFlight = false;
let authAttempt = 0;
let commentSaveInFlight = false;

const QR_SCAN_OPTIONS = {
  delayBetweenScanAttempts: 120,
  delayBetweenScanSuccess: 500,
  tryPlayVideoTimeout: 3000
};
const QR_SCAN_ARM_DELAY_MS = 750;
const LOCATION_MAX_AGE_MS = 30000;
const LOCATION_TIMEOUT_MS = 12000;
const VIEWPORT_CONTENT = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

const tourSync = createTourSync({
  store: tourStore,
  send: saveTourRemote,
  getSession: () => state.session,
  isOnline: () => navigator.onLine,
  onStatus: (status, agentId) => {
    if (state.agent?.id !== agentId || state.syncStatus === "storage-error") return;
    state.syncStatus = status;
    updateSyncStatus();
  },
  onAuthRejected: (agentId) => {
    if (state.agent?.id === agentId) forceAgentLogout("Session agent expirée · vos tournées sont conservées");
  }
});
let workspaceReady;
function prepareWorkspace() {
  if (!workspaceReady) {
    workspaceReady = migrateLegacyTours(tourStore, [loadActiveTour(), ...loadTourHistory()], clearLegacyTours)
      .then(() => true)
      .catch((error) => {
        console.warn("Patrol recovery failed:", error);
        workspaceReady = null;
        state.syncStatus = "storage-error";
        updateSyncStatus();
        return false;
      });
  }
  return workspaceReady;
}
prepareWorkspace();

setupViewportHeight();
bindEvents();
initialize();
registerServiceWorker();

async function initialize() {
  const remembered = loadRememberedSession();
  state.restoringSession = Boolean(remembered?.token && navigator.onLine);
  render();
  document.documentElement.dataset.appReady = "true";
  flushSessionRevocations();
  window.setInterval(flushSessionRevocations, 60000);
  window.setInterval(() => tourSync.flush(), 30000);
  try {
    if (state.restoringSession) {
      const attempt = authAttempt;
      const result = await resumeRememberedAgent(remembered.token).catch((error) => ({ ok: false, error }));
      if (state.agent || authAttempt !== attempt) return;
      if (result.ok) {
        state.agent = result.agent;
        state.credentials = { token: remembered.token };
        state.session = { agentId: state.agent.id, credentials: state.credentials };
        if (!await restoreAgentWorkspace()) { resetAgentState(); return; }
        if (await loadRoutes(state.credentials)) {
          tourSync.flush();
        } else {
          resetAgentState(false);
        }
      } else if (result.invalidCredentials) {
        clearAgent();
      }
    }
  } catch (error) {
    console.warn("Session restoration failed:", error);
    resetAgentState(false);
    showToast("Reconnexion impossible · réessayez de vous connecter");
  } finally {
    state.restoringSession = false;
    render();
    startAgentSessionMonitoring();
  }
}

async function loadRoutes(credentials) {
  const session = state.session;
  const result = await fetchAgentRoutes(credentials);
  if (state.session !== session) return false;
  if (!result.ok) console.warn("Site configuration load failed:", result.error);
  state.routes = result.ok ? result.routes : [];
  const preferredSiteId = state.activeTour?.siteId || state.agent?.siteId;
  state.route = state.routes.find((route) => route.siteId === preferredSiteId)
    || (state.routes.length === 1 ? state.routes[0] : null);
  return result.ok && state.routes.length > 0;
}

async function restoreAgentWorkspace() {
  if (!await prepareWorkspace()) {
    showToast("Stockage indisponible · réessayez après avoir libéré de l’espace");
    return false;
  }
  const session = state.session;
  try {
    const records = await tourStore.all();
    if (!session || state.session !== session) return false;
    Object.assign(state, selectAgentTours(session.agentId, records));
    state.syncStatus = records.some((record) => record.pending && record.tour.agentId === session.agentId) ? "pending" : "synced";
    updateSyncStatus();
    return true;
  } catch (error) {
    console.warn("Patrol recovery failed:", error);
    state.syncStatus = "storage-error";
    updateSyncStatus();
    showToast("Lecture des tournées impossible · réessayez");
    return false;
  }
}

function updateSyncStatus() {
  dom.syncStatus.hidden = !state.agent && state.syncStatus !== "storage-error";
  dom.syncStatus.dataset.status = state.syncStatus;
  dom.syncStatus.textContent = state.syncStatus === "storage-error"
    ? "Enregistrement local impossible · aucune validation n’a été effectuée"
    : state.syncStatus === "pending"
      ? "Enregistré sur cet appareil · synchronisation en attente"
      : "Tournées synchronisées";
}

function setupViewportHeight() {
  const update = () => {
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
  };

  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", () => window.setTimeout(update, 120));
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
}

function resetViewportZoom() {
  if (dom.viewportMeta) {
    dom.viewportMeta.setAttribute("content", VIEWPORT_CONTENT);
  }

  window.setTimeout(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, 0);
}

function bindEvents() {
  dom.signOutButton.addEventListener("click", () => {
    if (!canSignOut()) return;
    const token = state.credentials?.token || loadRememberedSession()?.token;
    authAttempt += 1;
    resetAgentState();
    if (token) scheduleSessionRevocation(token);
    render();
    dom.mainView.querySelector('[name="agentBadge"]')?.focus();
    showToast("Déconnecté · vos tournées sont conservées");
  });


  window.addEventListener("online", () => {
    flushSessionRevocations();
    validateAgentSession();
    tourSync.flush();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { validateAgentSession(); tourSync.flush(); }
  });

  dom.mainView.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (event.target.id === "commentForm") {
      const formData = new FormData(event.target);
      await finishCommentStep(formData.get("tourComment"));
      return;
    }

    if (event.target.id !== "loginForm") {
      return;
    }

    const form = event.target;
    const formData = new FormData(form);
    const badge = String(formData.get("agentBadge") || "").trim();
    const pin = String(formData.get("agentPin") || "");
    const remember = formData.has("rememberAgent");
    const submitButton = form.querySelector('button[type="submit"]');

    if (!badge || !/^\d{6}$/.test(pin)) {
      showToast("Matricule et PIN requis");
      return;
    }

    const loginMessage = form.querySelector("#loginMessage");
    loginMessage.textContent = "";
    loginMessage.hidden = true;
    submitButton.disabled = true;
    submitButton.textContent = "Vérification...";
    authAttempt += 1;
    const result = await authenticateAgent({ badge, pin, remember }).catch((error) => ({ ok: false, error }));

    if (!result.ok) {
      submitButton.disabled = false;
      submitButton.textContent = "Se connecter";
      const minutes = result.retryAfterSeconds > 0 ? Math.ceil(result.retryAfterSeconds / 60) : null;
      loginMessage.textContent = result.locked
        ? `Connexion temporairement bloquée après plusieurs tentatives. ${minutes ? `Réessaie dans environ ${minutes} minute${minutes > 1 ? "s" : ""}` : "Réessaie plus tard"} ou contacte ton responsable.`
        : result.invalidCredentials ? "Matricule ou PIN incorrect." : "Connexion indisponible. Vérifie ta connexion et réessaie.";
      loginMessage.hidden = false;
      return;
    }

    state.agent = result.agent;
    state.credentials = result.token
      ? { token: result.token }
      : { badge: result.agent.badge, pin, sessionEpoch: result.sessionEpoch };
    state.session = { agentId: result.agent.id, credentials: state.credentials };
    if (!await restoreAgentWorkspace()) {
      if (result.token) scheduleSessionRevocation(result.token);
      resetAgentState();
      render();
      return;
    }
    const routeLoaded = await loadRoutes(state.credentials).catch(() => false);
    if (!routeLoaded) {
      if (result.token) scheduleSessionRevocation(result.token);
      state.agent = null;
      state.credentials = null;
      state.session = null;
      state.activeTour = null;
      state.history = [];
      updateSyncStatus();
      showToast("Configuration du site indisponible");
      render();
      return;
    }
    const previous = loadRememberedSession()?.token;
    if (previous && previous !== result.token) scheduleSessionRevocation(previous);
    clearAgent();
    if (result.token && !saveRememberedSession({ token: result.token })) {
      showToast("Connexion active · impossible de mémoriser cet appareil");
    }
    startAgentSessionMonitoring();
    render();
    tourSync.flush();
  });

  dom.mainView.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-action]");
    const action = actionButton?.dataset.action;
    if (!action) {
      return;
    }

    if (action === "start") {
      state.pendingStart = true;
      state.lastOutcomeTour = null;
      render();
    }

    if (action === "scan") {
      await prepareLocationAndOpenScanner(actionButton);
    }

    if (action === "cancel-start") {
      state.pendingStart = false;
      render();
    }

    if (action === "cancel") {
      openCancelSheet();
    }

    if (action === "incident") {
      openIncidentSheet();
    }

    if (action === "comment-skip") {
      await finishCommentStep("");
    }
  });

  dom.mainView.addEventListener("focusin", (event) => {
    if (!event.target.matches("[data-keyboard-field]")) {
      return;
    }

    document.body.classList.add("keyboard-open");
    resetViewportZoom();
    window.setTimeout(() => {
      event.target.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 180);
  });

  dom.mainView.addEventListener("focusout", (event) => {
    if (!event.target.matches("[data-keyboard-field]")) {
      return;
    }

    window.setTimeout(() => {
      if (!dom.mainView.contains(document.activeElement)) {
        document.body.classList.remove("keyboard-open");
        resetViewportZoom();
      }
    }, 120);
  });

  dom.closeScannerButton.addEventListener("click", closeScanner);
  dom.startCameraButton.addEventListener("click", startCamera);

  dom.scannerSheet.addEventListener("click", (event) => {
    if (event.target === dom.scannerSheet) {
      closeScanner();
    }
  });

  dom.closeCancelButton.addEventListener("click", closeCancelSheet);
  dom.cancelSheet.addEventListener("click", (event) => {
    if (event.target === dom.cancelSheet) {
      closeCancelSheet();
      return;
    }

    const reason = event.target.closest("[data-reason]")?.dataset.reason;
    if (!reason) {
      return;
    }

    state.selectedCancelReason = state.selectedCancelReason === reason ? "" : reason;
    dom.cancelReason.value = state.selectedCancelReason;
    updateReasonButtons();
  });

  dom.confirmCancelButton.addEventListener("click", async () => {
    if (dom.confirmCancelButton.disabled) return;
    dom.confirmCancelButton.disabled = true;
    try {
      const reason = dom.cancelReason.value.trim();
      const cancelled = cancelTour(state.activeTour, reason);
      if (!cancelled) {
        closeCancelSheet();
        return;
      }

      if (!await persistTour(cancelled)) return;
      state.history = [cancelled, ...state.history.filter((tour) => tour.id !== cancelled.id)].slice(0, 25);
      state.lastOutcomeTour = cancelled;
      state.activeTour = null;
      state.pendingStart = false;
      if (state.routes.length > 1) state.route = null;
      closeCancelSheet();
      showToast("Tournée annulée");
      render();
    } finally { dom.confirmCancelButton.disabled = false; }
  });

  dom.closeIncidentButton.addEventListener("click", closeIncidentSheet);
  dom.incidentSheet.addEventListener("click", (event) => {
    if (event.target === dom.incidentSheet) {
      closeIncidentSheet();
      return;
    }
  });
  dom.incidentForm.addEventListener("submit", submitIncident);
  dom.incidentPhoto.addEventListener("change", () => {
    document.getElementById("incidentPhotoName").textContent = dom.incidentPhoto.files[0]?.name || "Prendre une photo ou choisir une image";
  });
  dom.incidentSheet.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeIncidentSheet();
    }
    if (event.key === "Tab") {
      const controls = [...dom.incidentSheet.querySelectorAll("button:not(:disabled), input, textarea")];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

function startAgentSessionMonitoring() {
  window.clearInterval(sessionMonitorId);
  sessionMonitorId = null;
  if (!state.agent || !state.credentials) return;
  sessionMonitorId = window.setInterval(validateAgentSession, 15000);
}

function scheduleSessionRevocation(token) {
  queueSessionRevocation(token);
  flushSessionRevocations();
}

async function flushSessionRevocations() {
  if (!navigator.onLine) return;
  for (const token of loadPendingRevocations()) {
    if (await revokeRememberedAgent(token)) clearPendingRevocation(token);
  }
}

async function validateAgentSession() {
  if (sessionCheckInFlight || !state.agent || !state.credentials || !navigator.onLine) return;
  sessionCheckInFlight = true;
  const session = state.session;
  try {
    const result = await checkAgentSession(state.credentials);
    if (state.session === session && result.ok && !result.valid) {
      forceAgentLogout("Session fermée par le responsable · vos tournées sont conservées");
    }
  } catch (error) {
    console.warn("Session check unavailable:", error);
  } finally {
    sessionCheckInFlight = false;
  }
}

function resetAgentState(clearSavedCredentials = true) {
  window.clearInterval(sessionMonitorId);
  sessionMonitorId = null;
  if (clearSavedCredentials) clearAgent();
  state.agent = null;
  state.credentials = null;
  state.session = null;
  state.activeTour = null;
  state.history = [];
  state.routes = [];
  state.route = null;
  state.pendingStart = false;
  state.commentTour = null;
  state.lastOutcomeTour = null;
  if (state.syncStatus !== "storage-error") state.syncStatus = "";
  updateSyncStatus();
}

function forceAgentLogout(message) {
  if (state.scannerOpen) closeScanner();
  if (state.cancelOpen) closeCancelSheet();
  if (state.incidentOpen) closeIncidentSheet();
  resetAgentState();
  render();
  showToast(message);
}

function canSignOut() {
  return Boolean(state.agent && !state.restoringSession && !state.activeTour
    && !state.commentTour && !state.pendingStart && !state.scannerOpen
    && !state.cancelOpen && !state.incidentOpen);
}

function render() {
  dom.signOutButton.hidden = !canSignOut();
  dom.signOutButton.disabled = !canSignOut();
  resetViewportZoom();



  if (state.restoringSession) {
    dom.mainView.innerHTML = renderStartupSkeleton();
    return;
  }

  if (!state.agent) {
    dom.mainView.innerHTML = renderLogin();
    return;
  }

  if (state.commentTour) {
    dom.mainView.innerHTML = renderCommentStep(state.commentTour);
    return;
  }

  if (state.activeTour) {
    dom.mainView.innerHTML = renderActiveTour(state.activeTour);
    return;
  }

  if (state.pendingStart) {
    dom.mainView.innerHTML = renderPendingStart();
    return;
  }

  dom.mainView.innerHTML = renderReady();
}

function renderStartupSkeleton() {
  return `
    <div class="stack startup-skeleton">
      <p class="startup-status" role="status">Reconnexion en cours…</p>
      <div aria-hidden="true" class="stack">
        <section class="status-panel skeleton-panel">
          <div class="skeleton-block skeleton-short"></div>
          <div class="skeleton-block skeleton-title"></div>
          <div class="skeleton-block skeleton-copy"></div>
          <div class="skeleton-block skeleton-button"></div>
        </section>
        <section class="status-panel skeleton-panel">
          <div class="skeleton-block skeleton-short"></div>
          <div class="skeleton-block skeleton-row"></div>
          <div class="skeleton-block skeleton-row"></div>
        </section>
      </div>
    </div>
  `;
}

function renderLogin() {
  return `
    <section class="login-panel">
      <div class="login-title">
        <p class="eyebrow">Accès sécurisé</p>
        <h2>Connexion agent</h2>
      </div>
      <form class="field-stack" id="loginForm" autocomplete="off">
        <label>
          Matricule
          <input name="agentBadge" type="text" autocomplete="username" maxlength="32" required>
        </label>
        <label>
          Code PIN
          <input name="agentPin" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" minlength="6" maxlength="6" required>
        </label>
        <label class="remember-agent">
          <input name="rememberAgent" type="checkbox">
          <span class="remember-agent-copy">
            <span>Rester connecté</span>
            <small>Sur cet appareil uniquement · 30 jours</small>
          </span>
          <span class="remember-agent-switch" aria-hidden="true"></span>
        </label>
        <button class="primary-button" type="submit">Se connecter</button>
        <p id="loginMessage" class="login-message" role="alert" aria-atomic="true" hidden></p>
      </form>
    </section>
  `;
}

function renderReady() {
  const latest = [state.lastOutcomeTour, ...state.history].find((tour) => tour?.agentId === state.agent.id) || null;
  const startPoint = state.route?.points.find((point) => point.kind === "start");
  return `
    <div class="stack">
      <section class="status-panel">
        <div class="status-top">
          <div>
            <p class="eyebrow">${escapeHtml(state.agent.name)}</p>
            <h2 class="status-title">Prêt pour une tournée</h2>
            <p class="status-copy">${state.routes.length > 1 && !state.route
              ? "Site détecté automatiquement au scan du Poste A"
              : `${escapeHtml(state.route?.siteName || "Site")} · Départ : ${escapeHtml(startPoint?.label || "Poste A")}`}</p>
          </div>
          <span class="status-pill idle">Libre</span>
        </div>
        <button class="primary-button" type="button" data-action="start">Nouvelle tournée</button>
      </section>
      ${latest ? renderOutcome(latest) : ""}
      ${renderHistory()}
    </div>
  `;
}

function renderPendingStart() {
  const startPoint = state.route?.points.find((point) => point.kind === "start");
  return `
    <div class="stack">
      <section class="status-panel">
        <div class="status-top">
          <div>
            <p class="eyebrow">Démarrage</p>
            <h2 class="status-title">${escapeHtml(startPoint?.label || "Poste A")} attendu</h2>
            <p class="status-copy">${state.routes.length > 1 ? "Le site sera reconnu automatiquement grâce au QR de départ." : "La tournée sera ouverte à l'heure du scan."}</p>
          </div>
          <span class="status-pill pending">Attente</span>
        </div>
      </section>
      <div class="dock">
        <div class="two-actions">
          <button class="secondary-button" type="button" data-action="cancel-start">Annuler</button>
          <button class="primary-button" type="button" data-action="scan">Scanner</button>
        </div>
      </div>
      ${state.route ? renderPointRows(null) : ""}
    </div>
  `;
}

function renderActiveTour(tour) {
  const checkpointCount = getScannedCheckpointIds(tour).size;
  const checkpointIds = getRouteCheckpointIds(tour.route);
  const phase = getTourPhase(tour);
  const readyToClose = phase === "awaiting_close";
  const remainingCount = checkpointIds.length - checkpointCount;
  const nextTitle = readyToClose ? "Retour Poste A" : "Points de contrôle";
  const nextCopy = readyToClose
    ? "Les trois points sont validés. Scannez le Poste A pour clôturer."
    : `${remainingCount} point${remainingCount > 1 ? "s" : ""} à scanner. Appuyez sur Nouveau scan à chaque point.`;
  const primaryLabel = readyToClose ? "Clôturer au Poste A" : "Nouveau scan";

  return `
    <div class="stack">
      <section class="status-panel">
        <div class="status-top">
          <div>
            <p class="eyebrow">Tournée active</p>
            <h2 class="status-title">${nextTitle}</h2>
            <p class="status-copy">${nextCopy}</p>
          </div>
          <span class="status-pill ${readyToClose ? "" : "pending"}">${readyToClose ? "À clôturer" : `${checkpointCount}/${checkpointIds.length}`}</span>
        </div>
        <div class="metric-strip">
          <div class="metric"><span>Départ</span><strong>${formatTime(tour.startedAt)}</strong></div>
          <div class="metric"><span>Validés</span><strong>${checkpointCount}/${checkpointIds.length}</strong></div>
          <div class="metric"><span>Agent</span><strong>${escapeHtml(tour.agentBadge)}</strong></div>
        </div>
      </section>
      <div class="dock">
        <p class="dock-hint">${readyToClose ? "Dernière étape : retour au Poste A." : "Quand vous arrivez au prochain point, lancez la caméra."}</p>
        <div class="two-actions">
          <button class="primary-button" type="button" data-action="scan">${primaryLabel}</button>
          <button class="report-button" type="button" data-action="incident">Signaler</button>
        </div>
        <button class="secondary-button" type="button" data-action="cancel">Annuler</button>
      </div>
      ${renderPointRows(tour)}
    </div>
  `;
}

function renderPointRows(tour) {
  const displayTour = tour || { route: state.route, scans: [] };
  const progress = getPointProgress(displayTour);
  const closingScan = getClosingScan(tour);
  const scannedCount = getScannedCheckpointIds(tour).size;
  const route = displayTour.route;
  const startPointId = route?.startPointId || route?.points?.find((point) => point.kind === "start")?.id;
  const checkpointIds = getRouteCheckpointIds(route);
  const rows = progress.map(({ point, scan, done }) => {
    const locked = !tour && point.id !== startPointId;
    const next = !done && !locked;
    return `
      <article class="point-row ${done ? "done" : ""} ${next ? "next" : ""} ${locked ? "locked" : ""}">
        <span class="point-state">${done ? "✓" : locked ? "·" : "QR"}</span>
        <span class="point-main">
          <span class="point-name">${escapeHtml(point.label)}</span>
          <span class="point-kind">${point.kind === "start" ? "Poste de départ" : "Point de contrôle"}</span>
        </span>
        <span class="point-time">${scan ? formatTime(scan.scannedAt) : "--:--"}</span>
      </article>
    `;
  }).join("");

  const closeLocked = scannedCount !== checkpointIds.length;
  const closeDone = Boolean(closingScan);

  return `
    <section class="point-list">
      ${rows}
      <article class="point-row ${closeDone ? "done" : ""} ${!closeLocked && !closeDone ? "next" : ""} ${closeLocked ? "locked" : ""}">
        <span class="point-state">${closeDone ? "✓" : closeLocked ? "·" : "QR"}</span>
        <span class="point-main">
          <span class="point-name">Retour ${escapeHtml(progress.find(({ point }) => point.id === startPointId)?.point.label || "Poste A")}</span>
          <span class="point-kind">Clôture</span>
        </span>
        <span class="point-time">${closingScan ? formatTime(closingScan.scannedAt) : "--:--"}</span>
      </article>
    </section>
  `;
}

function renderCommentStep(tour) {
  return `
    <div class="stack comment-step">
      <section class="status-panel">
        <div class="status-top">
          <div>
            <p class="eyebrow">Fin de tournée</p>
            <h2 class="status-title">Commentaire</h2>
            <p class="status-copy">Ajoutez une remarque utile pour le patron, si nécessaire.</p>
          </div>
          <span class="status-pill">Clôturée</span>
        </div>
        <form class="field-stack" id="commentForm">
          <label>
            Commentaire de tournée
            <textarea name="tourComment" rows="5" maxlength="500" placeholder="Exemple : portail arrière vérifié, rien à signaler." data-keyboard-field>${escapeHtml(tour.comment || "")}</textarea>
          </label>
          <button class="primary-button" type="submit">Enregistrer</button>
          <button class="secondary-button" type="button" data-action="comment-skip">Passer</button>
        </form>
      </section>
      <section class="summary-panel">
        <p class="eyebrow">Scans validés</p>
        ${renderScanLog(tour)}
      </section>
    </div>
  `;
}

function renderOutcome(tour) {
  const isCompleted = tour.status === "completed";
  const title = isCompleted ? "Tournée clôturée" : "Tournée annulée";
  const subtitle = isCompleted
    ? `${formatTime(tour.startedAt)} - ${formatTime(tour.completedAt)}`
    : `${formatTime(tour.startedAt)} - ${formatTime(tour.cancelledAt)}`;
  const reason = !isCompleted && tour.cancelReason ? `<p class="muted">Motif : ${escapeHtml(tour.cancelReason)}</p>` : "";
  const comment = tour.comment ? `<p class="muted">Commentaire : ${escapeHtml(tour.comment)}</p>` : "";

  return `
    <section class="summary-panel">
      <p class="eyebrow">${isCompleted ? "Terminé" : "Arrêté"}</p>
      <h3>${title}</h3>
      <p class="muted">${subtitle}</p>
      ${reason}
      ${comment}
      ${renderScanLog(tour)}
    </section>
  `;
}

function renderHistory() {
  const history = state.history.filter((tour) => tour.agentId === state.agent?.id);
  if (!history.length) {
    return "";
  }

  const rows = history.slice(0, 3).map((tour) => {
    const label = tour.status === "completed" ? "Clôturée" : "Annulée";
    const endTime = tour.completedAt || tour.cancelledAt;
    return `
      <div class="scan-log-row">
        <strong>${label}</strong>
        <span>${formatTime(tour.startedAt)} - ${formatTime(endTime)}</span>
      </div>
    `;
  }).join("");

  return `
    <section class="summary-panel">
      <p class="eyebrow">Historique local</p>
      <div class="scan-log">${rows}</div>
    </section>
  `;
}

function renderScanLog(tour) {
  const rows = (tour.scans || []).map((scan) => `
    <div class="scan-log-row">
      <strong>${escapeHtml(scan.pointLabel)}</strong>
      <span>${formatTime(scan.scannedAt)}</span>
    </div>
  `).join("");

  return `<div class="scan-log">${rows}</div>`;
}

function openScanner() {
  resetViewportZoom();
  state.scannerOpen = true;
  scanner.armedAt = performance.now() + QR_SCAN_ARM_DELAY_MS;
  dom.scannerSheet.classList.add("is-open");
  dom.scannerSheet.setAttribute("aria-hidden", "false");
  dom.scannerTitle.textContent = getScannerTitle();
  dom.cameraState.textContent = "Ouverture caméra...";
  dom.startCameraButton.hidden = false;
  dom.startCameraButton.disabled = true;
  dom.startCameraButton.textContent = "Ouverture caméra...";
  startCamera();
}

async function prepareLocationAndOpenScanner(actionButton) {
  if (scanner.starting || state.scannerOpen || actionButton?.disabled) {
    return;
  }

  const originalLabel = actionButton?.textContent || "Scanner";
  if (actionButton) {
    actionButton.disabled = true;
    actionButton.textContent = "Localisation...";
    actionButton.setAttribute("aria-busy", "true");
  }

  try {
    const location = await requestCurrentLocation();
    scanner.locationPromise = Promise.resolve(location);
    openScanner();
  } catch (error) {
    console.warn("Location permission failed before scanner:", error);
    showToast(getLocationErrorMessage(error));
  } finally {
    if (actionButton?.isConnected) {
      actionButton.disabled = false;
      actionButton.textContent = originalLabel;
      actionButton.removeAttribute("aria-busy");
    }
  }
}

function closeScanner() {
  stopCamera();
  scanner.locationPromise = null;
  state.scannerOpen = false;
  dom.scannerSheet.classList.remove("is-open");
  dom.scannerSheet.setAttribute("aria-hidden", "true");
  resetViewportZoom();
}

async function startCamera() {
  if (scanner.starting || scanner.stream || scanner.zxingControls) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    dom.cameraState.textContent = "Caméra indisponible";
    dom.startCameraButton.hidden = false;
    dom.startCameraButton.disabled = false;
    dom.startCameraButton.textContent = "Réessayer la caméra";
    showToast("Scanner caméra requis");
    return;
  }

  scanner.starting = true;
  dom.startCameraButton.disabled = true;
  dom.startCameraButton.textContent = "Ouverture caméra...";

  try {
    if ("BarcodeDetector" in window) {
      await startNativeScanner();
      markCameraStarted();
      return;
    }

    const zxingModule = await loadZxingModule();
    if (zxingModule?.BrowserQRCodeReader) {
      await startZxingScanner(zxingModule);
      markCameraStarted();
      return;
    }

    dom.cameraState.textContent = "Scanner QR indisponible";
    dom.startCameraButton.hidden = false;
    dom.startCameraButton.disabled = false;
    dom.startCameraButton.textContent = "Réessayer la caméra";
    showToast("Navigateur non compatible");
  } catch (error) {
    console.warn("Camera start failed:", error);
    dom.cameraState.textContent = getCameraErrorMessage(error);
    dom.startCameraButton.hidden = false;
    dom.startCameraButton.disabled = false;
    dom.startCameraButton.textContent = "Réessayer la caméra";
    showToast("Scanner caméra requis");
  } finally {
    scanner.starting = false;
  }
}

function markCameraStarted() {
  dom.startCameraButton.hidden = true;
  dom.startCameraButton.disabled = false;
  dom.startCameraButton.textContent = "Réessayer la caméra";
}

async function getScanLocation() {
  let location = scanner.locationPromise ? await scanner.locationPromise : null;
  const capturedAt = location?.capturedAt ? new Date(location.capturedAt).getTime() : 0;

  if (!location || Date.now() - capturedAt > LOCATION_MAX_AGE_MS) {
    scanner.locationPromise = requestCurrentLocation();
    location = await scanner.locationPromise;
  }

  return location;
}

function requestCurrentLocation() {
  if (!navigator.geolocation) {
    return Promise.reject({ code: 0, message: "Geolocation unavailable" });
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        capturedAt: new Date(position.timestamp || Date.now()).toISOString()
      }),
      reject,
      {
        enableHighAccuracy: true,
        timeout: LOCATION_TIMEOUT_MS,
        maximumAge: 5000
      }
    );
  });
}

function isScannerArmed() {
  return performance.now() >= (scanner.armedAt || 0);
}

function getCameraConstraints() {
  return {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  };
}

async function applyCameraOptimizations(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track?.getCapabilities || !track.applyConstraints) {
    return;
  }

  try {
    const capabilities = track.getCapabilities();
    if (capabilities.focusMode?.includes("continuous")) {
      await track.applyConstraints({
        advanced: [{ focusMode: "continuous" }]
      });
    }
  } catch (error) {
    console.warn("Camera optimization skipped:", error);
  }
}

async function applyZxingCameraOptimizations(controls) {
  try {
    await controls?.streamVideoConstraintsApply?.({
      advanced: [{ focusMode: "continuous" }]
    });
  } catch (error) {
    console.warn("Camera optimization skipped:", error);
  }
}

async function loadZxingModule() {
  if (scanner.zxingModule) {
    return scanner.zxingModule;
  }

  scanner.zxingModule = await import("https://esm.sh/@zxing/browser@0.1.5");
  return scanner.zxingModule;
}

async function startNativeScanner() {
  scanner.detector = scanner.detector || new window.BarcodeDetector({ formats: ["qr_code"] });
  scanner.stream = await navigator.mediaDevices.getUserMedia(getCameraConstraints());
  await applyCameraOptimizations(scanner.stream);
  dom.scannerVideo.srcObject = scanner.stream;
  await dom.scannerVideo.play();
  dom.cameraState.textContent = "Stabilisez le QR dans le cadre";
  scanFrame();
}

async function startZxingScanner(zxingModule) {
  scanner.zxingReader = scanner.zxingReader || new zxingModule.BrowserQRCodeReader(undefined, QR_SCAN_OPTIONS);
  scanner.zxingControls = await scanner.zxingReader.decodeFromConstraints(
    getCameraConstraints(),
    dom.scannerVideo,
    (result, error) => {
      if (result && !scanner.locked) {
        if (!isScannerArmed()) {
          return;
        }

        scanner.locked = true;
        handleScan(result.getText()).finally(() => {
          window.setTimeout(() => {
            scanner.locked = false;
          }, 900);
        });
        return;
      }

      if (error?.name && error.name !== "NotFoundException") {
        console.warn("QR detect failed:", error);
      }
    }
  );
  await applyZxingCameraOptimizations(scanner.zxingControls);
  dom.cameraState.textContent = "Stabilisez le QR dans le cadre";
}

async function scanFrame() {
  if (!scanner.stream || !scanner.detector) {
    return;
  }

  try {
    const codes = await scanner.detector.detect(dom.scannerVideo);
    const firstCode = codes[0]?.rawValue;
    if (firstCode && !scanner.locked) {
      if (!isScannerArmed()) {
        scanner.loopId = window.requestAnimationFrame(scanFrame);
        return;
      }

      scanner.locked = true;
      handleScan(firstCode).finally(() => {
        window.setTimeout(() => {
          scanner.locked = false;
          if (state.scannerOpen && scanner.stream) {
            scanner.loopId = window.requestAnimationFrame(scanFrame);
          }
        }, 900);
      });
      return;
    }
  } catch (error) {
    console.warn("QR detect failed:", error);
  }

  scanner.loopId = window.requestAnimationFrame(scanFrame);
}

function stopCamera() {
  if (scanner.zxingControls) {
    scanner.zxingControls.stop();
    scanner.zxingControls = null;
  }

  if (scanner.loopId) {
    window.cancelAnimationFrame(scanner.loopId);
    scanner.loopId = null;
  }

  if (scanner.stream) {
    scanner.stream.getTracks().forEach((track) => track.stop());
    scanner.stream = null;
  }

  dom.scannerVideo.srcObject = null;
}

async function handleScan(rawPayload) {
  if (!state.agent) {
    showToast("Connexion requise");
    closeScanner();
    return;
  }

  dom.cameraState.textContent = "Validation de la position...";
  let gps;
  try {
    gps = await getScanLocation();
  } catch (error) {
    console.warn("Location required for scan:", error);
    const message = getLocationErrorMessage(error);
    closeScanner();
    showToast(message);
    return;
  }

  const scannedAt = new Date();

  if (!state.activeTour) {
    const selectedRoute = state.route || findRouteForStartPayload(rawPayload, state.routes);
    if (!selectedRoute) {
      showToast("QR de départ non autorisé");
      dom.cameraState.textContent = "Scannez le Poste A du site";
      return;
    }
    state.route = selectedRoute;
    const result = startTour(state.agent, rawPayload, scannedAt, gps, selectedRoute);
    if (!result.ok) {
      showToast(getReasonMessage(result.reason));
      dom.cameraState.textContent = "Stabilisez le QR dans le cadre";
      return;
    }

    if (!await persistTour(result.tour)) return;
    state.activeTour = result.tour;
    state.pendingStart = false;
    closeScanner();
    showToast("Tournée démarrée");
    render();
    return;
  }

  const result = applyScan(state.activeTour, rawPayload, scannedAt, gps);
  if (!result.ok) {
    showToast(getReasonMessage(result.reason));
    dom.cameraState.textContent = "Stabilisez le QR dans le cadre";
    return;
  }

  if (!await persistTour(result.tour)) return;
  state.activeTour = result.tour;

  if (result.completed) {
    state.history = [result.tour, ...state.history.filter((tour) => tour.id !== result.tour.id)].slice(0, 25);
    state.commentTour = result.tour;
    state.lastOutcomeTour = null;
    state.activeTour = null;
    closeScanner();
    showToast("Tournée clôturée");
    render();
    return;
  }

  closeScanner();
  showToast(result.readyToClose ? "Retour Poste A requis" : "Point validé");
  render();
}

async function finishCommentStep(rawComment) {
  if (!state.commentTour || commentSaveInFlight) {
    return;
  }
  commentSaveInFlight = true;
  try {
    const updatedTour = setTourComment(state.commentTour, rawComment);
    if (!await persistTour(updatedTour)) return;
    state.history = [updatedTour, ...state.history.filter((tour) => tour.id !== updatedTour.id)].slice(0, 25);
    state.commentTour = null;
    state.lastOutcomeTour = updatedTour;
    if (state.routes.length > 1) state.route = null;
    showToast(updatedTour.comment ? "Commentaire ajouté" : "Tournée enregistrée");
    render();
  } finally { commentSaveInFlight = false; }
}

async function persistTour(tour) {
  const session = state.session;
  if (!session || tour?.agentId !== session.agentId) return false;
  try {
    await tourSync.enqueue(tour);
    if (state.session !== session) return false;
    state.syncStatus = "pending";
    updateSyncStatus();
    window.setTimeout(() => tourSync.flush(), 0);
    return true;
  } catch (error) {
    console.warn("Local patrol save failed:", error);
    if (state.session === session) {
      state.syncStatus = "storage-error";
      updateSyncStatus();
      showToast("Enregistrement impossible · libérez de l’espace puis réessayez");
    }
    return false;
  }
}

function getScannerTitle() {
  if (!state.activeTour) {
    return "Scanner Poste A";
  }

  return getTourPhase(state.activeTour) === "awaiting_close" ? "Scanner retour Poste A" : "Scanner un point";
}

function getCameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "Autorisation caméra refusée";
  }

  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
    return "Aucune caméra disponible";
  }

  return "Caméra indisponible";
}

function getLocationErrorMessage(error) {
  if (error?.code === 1) {
    return "Autorisez la localisation pour scanner";
  }

  if (error?.code === 2) {
    return "Position GPS indisponible";
  }

  if (error?.code === 3) {
    return "Position GPS trop longue à obtenir";
  }

  return "Localisation requise pour scanner";
}

function openCancelSheet() {
  if (!state.activeTour) {
    return;
  }

  state.cancelOpen = true;
  state.selectedCancelReason = "";
  dom.cancelReason.value = "";
  dom.cancelSheet.classList.add("is-open");
  dom.cancelSheet.setAttribute("aria-hidden", "false");
  updateReasonButtons();
}

function closeCancelSheet() {
  state.cancelOpen = false;
  dom.cancelSheet.classList.remove("is-open");
  dom.cancelSheet.setAttribute("aria-hidden", "true");
}

function updateReasonButtons() {
  document.querySelectorAll("[data-reason]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.reason === state.selectedCancelReason);
  });
}

function openIncidentSheet() {
  if (!state.activeTour) return;
  state.incidentOpen = true;
  dom.incidentForm.reset();
  const submitButton = dom.incidentForm.querySelector('[type="submit"]');
  submitButton.disabled = false;
  submitButton.textContent = "Enregistrer le signalement";
  document.getElementById("incidentPhotoName").textContent = "Prendre une photo ou choisir une image";
  document.body.classList.add("incident-open");
  document.querySelector(".app-shell").inert = true;
  dom.incidentSheet.classList.add("is-open");
  dom.incidentSheet.setAttribute("aria-hidden", "false");
  dom.incidentSheet.querySelector(".sheet-panel").scrollTop = 0;
  dom.closeIncidentButton.focus({ preventScroll: true });
}

function closeIncidentSheet() {
  state.incidentOpen = false;
  dom.incidentSheet.classList.remove("is-open");
  dom.incidentSheet.setAttribute("aria-hidden", "true");
  document.body.classList.remove("incident-open");
  document.querySelector(".app-shell").inert = false;
  dom.mainView.querySelector('[data-action="incident"]')?.focus({ preventScroll: true });
}

async function submitIncident(event) {
  event.preventDefault();
  if (!state.activeTour) return;
  const button = event.target.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const capturedTour = state.activeTour;
  const note = dom.incidentNote.value;
  button.disabled = true;
  button.textContent = "Enregistrement...";

  try {
    const [gps, photoData] = await Promise.all([
      requestCurrentLocation(),
      compressIncidentPhoto(dom.incidentPhoto.files[0])
    ]);
    if (state.activeTour !== capturedTour || !state.incidentOpen) return;
    const updated = addTourIncident(capturedTour, {
      category: "Incident",
      note,
      photoData,
      gps,
      createdAt: new Date()
    });
    if (!await persistTour(updated)) {
      button.disabled = false;
      button.textContent = "Enregistrer le signalement";
      return;
    }
    state.activeTour = updated;
    closeIncidentSheet();
    showToast("Incident enregistré sur cet appareil");
    render();
  } catch (error) {
    console.warn("Incident capture failed:", error);
    button.disabled = false;
    button.textContent = "Enregistrer le signalement";
    showToast(typeof error?.code === "number" ? getLocationErrorMessage(error) : "Photo non enregistrée · choisissez une autre image");
  }
}

async function compressIncidentPhoto(file) {
  if (!file) return "";
  const image = await loadIncidentImage(file);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  let quality = 0.72;
  let data = canvas.toDataURL("image/jpeg", quality);
  while (data.length > 550000 && quality > 0.35) {
    quality -= 0.1;
    data = canvas.toDataURL("image/jpeg", quality);
  }
  if (data.length > 600000) throw new Error("Photo trop volumineuse");
  return data;
}

async function loadIncidentImage(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function getReasonMessage(reason) {
  const messages = {
    missing_agent: "Connexion requise",
    unknown_qr: "QR code inconnu",
    start_requires_post: "Scannez Poste A pour démarrer",
    close_requires_all_checkpoints: "Validez les trois points avant retour",
    checkpoint_already_scanned: "Point déjà validé",
    tour_not_active: "Aucune tournée active",
    invalid_point: "Point non valide"
  };
  return messages[reason] || "Scan refusé";
}

function formatTime(isoValue) {
  if (!isoValue) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(isoValue));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("show");
  }, 1500);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}
