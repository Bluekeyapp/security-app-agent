export const START_POST_ID = "post-a";

export const POINTS = [
  {
    id: START_POST_ID,
    label: "Poste A",
    kind: "Poste de départ",
    aliases: ["POST_A", "POST-A", "POSTEA", "POSTE_A", "A", "SEC:POST_A", "SECURITY_POST_A"]
  },
  {
    id: "checkpoint-1",
    label: "Point 1",
    kind: "Point de contrôle",
    aliases: ["CP_1", "CP-1", "CHECKPOINT_1", "POINT_1", "P1", "SEC:CP_1"]
  },
  {
    id: "checkpoint-2",
    label: "Point 2",
    kind: "Point de contrôle",
    aliases: ["CP_2", "CP-2", "CHECKPOINT_2", "POINT_2", "P2", "SEC:CP_2"]
  },
  {
    id: "checkpoint-3",
    label: "Point 3",
    kind: "Point de contrôle",
    aliases: ["CP_3", "CP-3", "CHECKPOINT_3", "POINT_3", "P3", "SEC:CP_3"]
  }
];

export const CHECKPOINT_IDS = POINTS
  .filter((point) => point.id !== START_POST_ID)
  .map((point) => point.id);

export const CANCEL_SUGGESTIONS = [
  "Incident",
  "Urgence",
  "QR code inaccessible"
];

const POINT_BY_ID = new Map(POINTS.map((point) => [point.id, point]));
const ALIAS_TO_POINT = new Map();

POINTS.forEach((point) => {
  ALIAS_TO_POINT.set(normalizeCode(point.id), point.id);
  point.aliases.forEach((alias) => ALIAS_TO_POINT.set(normalizeCode(alias), point.id));
});

export function createAgent({ name, badge }) {
  const cleanName = String(name || "").trim().slice(0, 80);
  const cleanBadge = String(badge || "").trim().slice(0, 32);

  if (!cleanName || !cleanBadge) {
    return null;
  }

  return {
    id: `agent-${normalizeCode(cleanBadge).toLowerCase()}`,
    name: cleanName,
    badge: cleanBadge
  };
}

export function startTour(agent, rawPayload, now = new Date(), gps = null, route = null) {
  if (!agent?.id) {
    return { ok: false, reason: "missing_agent" };
  }

  const activeRoute = normalizeRoute(route);
  const point = resolvePoint(rawPayload, activeRoute.points);
  if (!point) {
    return { ok: false, reason: "unknown_qr" };
  }

  if (point.id !== activeRoute.startPointId) {
    return { ok: false, reason: "start_requires_post" };
  }

  const tourId = createId("tour");
  const scannedAt = toIso(now);
  const tour = {
    id: tourId,
    agentId: agent.id,
    agentName: agent.name,
    agentBadge: agent.badge,
    status: "active",
    startedAt: scannedAt,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    comment: "",
    siteId: activeRoute.siteId,
    siteName: activeRoute.siteName,
    route: activeRoute,
    incidents: [],
    scans: [
      createScan({
        agentId: agent.id,
        tourId,
        point,
        type: "start",
        scannedAt,
        gps,
        sourcePayload: rawPayload
      })
    ]
  };

  return { ok: true, tour, scan: tour.scans[0] };
}

export function applyScan(tour, rawPayload, now = new Date(), gps = null) {
  if (!tour || tour.status !== "active") {
    return { ok: false, reason: "tour_not_active", tour };
  }

  const route = normalizeRoute(tour.route);
  const checkpointIds = getRouteCheckpointIds(route);
  const point = resolvePoint(rawPayload, route.points);
  if (!point) {
    return { ok: false, reason: "unknown_qr", tour };
  }

  const scannedCheckpointIds = getScannedCheckpointIds(tour);
  const allCheckpointsScanned = checkpointIds.every((id) => scannedCheckpointIds.has(id));

  if (point.id === route.startPointId) {
    if (!allCheckpointsScanned) {
      return { ok: false, reason: "close_requires_all_checkpoints", tour };
    }

    const scannedAt = toIso(now);
    const closeScan = createScan({
      agentId: tour.agentId,
      tourId: tour.id,
      point,
      type: "close",
      scannedAt,
      gps,
      sourcePayload: rawPayload
    });

    const completedTour = {
      ...tour,
      status: "completed",
      completedAt: scannedAt,
      scans: [...tour.scans, closeScan]
    };

    return { ok: true, tour: completedTour, scan: closeScan, completed: true };
  }

  if (!checkpointIds.includes(point.id)) {
    return { ok: false, reason: "invalid_point", tour };
  }

  if (scannedCheckpointIds.has(point.id)) {
    return { ok: false, reason: "checkpoint_already_scanned", tour };
  }

  const scannedAt = toIso(now);
  const checkpointScan = createScan({
    agentId: tour.agentId,
    tourId: tour.id,
    point,
    type: "checkpoint",
    scannedAt,
    gps,
    sourcePayload: rawPayload
  });

  const updatedTour = {
    ...tour,
    scans: [...tour.scans, checkpointScan]
  };

  return {
    ok: true,
    tour: updatedTour,
    scan: checkpointScan,
    readyToClose: getScannedCheckpointIds(updatedTour).size === checkpointIds.length
  };
}

export function cancelTour(tour, reason = "", now = new Date()) {
  if (!tour || tour.status !== "active") {
    return null;
  }

  return {
    ...tour,
    status: "cancelled",
    cancelledAt: toIso(now),
    cancelReason: String(reason || "").trim().slice(0, 180)
  };
}

export function setTourComment(tour, comment = "") {
  if (!tour) {
    return null;
  }

  return {
    ...tour,
    comment: String(comment || "").trim().slice(0, 500)
  };
}

export function addTourIncident(tour, incident = {}) {
  if (!tour || tour.status !== "active") return null;
  const category = String(incident.category || "Incident").trim().slice(0, 40);
  const note = String(incident.note || "").trim().slice(0, 500);
  return {
    ...tour,
    incidents: [...(tour.incidents || []), {
      id: createId("incident"),
      tourId: tour.id,
      category,
      note,
      photoData: String(incident.photoData || "").slice(0, 600000),
      gps: normalizeGps(incident.gps),
      createdAt: toIso(incident.createdAt || new Date())
    }]
  };
}

export function getPointProgress(tour) {
  const scansByPoint = new Map();
  (tour?.scans || []).forEach((scan) => {
    if (!scansByPoint.has(scan.pointId)) {
      scansByPoint.set(scan.pointId, scan);
    }
  });

  return normalizeRoute(tour?.route).points.map((point) => ({
    point,
    scan: scansByPoint.get(point.id) || null,
    done: scansByPoint.has(point.id)
  }));
}

export function getClosingScan(tour) {
  return (tour?.scans || []).find((scan) => scan.type === "close") || null;
}

export function getScannedCheckpointIds(tour) {
  return new Set(
    (tour?.scans || [])
      .filter((scan) => scan.type === "checkpoint")
      .map((scan) => scan.pointId)
  );
}

export function getTourPhase(tour) {
  if (!tour) {
    return "idle";
  }

  if (tour.status === "completed") {
    return "completed";
  }

  if (tour.status === "cancelled") {
    return "cancelled";
  }

  const scannedCount = getScannedCheckpointIds(tour).size;
  return scannedCount === getRouteCheckpointIds(tour.route).length ? "awaiting_close" : "in_progress";
}

export function resolvePoint(rawPayload, points = POINTS) {
  const id = resolvePointId(rawPayload, points);
  return id ? new Map(points.map((point) => [point.id, point])).get(id) : null;
}

export function findRouteForStartPayload(rawPayload, routes = []) {
  return routes.find((route) => {
    if (!route.points?.some((point) => point.kind === "start")) return false;
    const normalizedRoute = normalizeRoute(route);
    const point = resolvePoint(rawPayload, normalizedRoute.points);
    return point?.id === normalizedRoute.startPointId;
  }) || null;
}

export function resolvePointId(rawPayload, points = POINTS) {
  const candidates = extractCandidates(rawPayload);
  const aliases = buildAliasMap(points);

  for (const candidate of candidates) {
    const direct = aliases.get(normalizeCode(candidate));
    if (direct) {
      return direct;
    }
  }

  return null;
}

export function getPoint(pointId) {
  return POINT_BY_ID.get(pointId) || null;
}

export function getRouteCheckpointIds(route) {
  return normalizeRoute(route).points
    .filter((point) => point.id !== normalizeRoute(route).startPointId)
    .map((point) => point.id);
}

export function normalizeRoute(route) {
  const points = Array.isArray(route?.points) && route.points.length ? route.points : POINTS;
  const startPoint = points.find((point) => point.kind === "start") || points.find((point) => point.id === START_POST_ID) || points[0];
  return {
    siteId: route?.siteId || "00000000-0000-0000-0000-000000000001",
    siteName: route?.siteName || "Site de test",
    siteAddress: route?.siteAddress || "",
    startPointId: startPoint.id,
    points
  };
}

function buildAliasMap(points) {
  const aliases = new Map();
  points.forEach((point) => {
    aliases.set(normalizeCode(point.id), point.id);
    if (point.qrPayload) aliases.set(normalizeCode(point.qrPayload), point.id);
    (point.aliases || []).forEach((alias) => aliases.set(normalizeCode(alias), point.id));
  });
  return aliases;
}

function extractCandidates(rawPayload) {
  const raw = String(rawPayload || "").trim();
  if (!raw) {
    return [];
  }

  const candidates = [raw];

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      ["pointId", "point", "code", "checkpoint", "station", "id"].forEach((key) => {
        if (typeof parsed[key] === "string") {
          candidates.push(parsed[key]);
        }
      });
    }
  } catch {
    // Plain QR payloads are expected for the prototype.
  }

  try {
    const url = new URL(raw);
    ["pointId", "point", "code", "checkpoint", "station", "id"].forEach((key) => {
      const value = url.searchParams.get(key);
      if (value) {
        candidates.push(value);
      }
    });
  } catch {
    // Non-URL payloads are accepted.
  }

  return candidates;
}

function createScan({ agentId, tourId, point, type, scannedAt, gps, sourcePayload }) {
  return {
    id: createId("scan"),
    tourId,
    agentId,
    pointId: point.id,
    pointLabel: point.label,
    type,
    scannedAt,
    gps: normalizeGps(gps),
    sourcePayload: String(sourcePayload || "").trim().slice(0, 160)
  };
}

function normalizeGps(gps) {
  const lat = Number(gps?.lat);
  const lng = Number(gps?.lng);
  const accuracy = Number(gps?.accuracy);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : null,
    capturedAt: gps?.capturedAt ? toIso(gps.capturedAt) : new Date().toISOString()
  };
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toIso(value) {
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date().toISOString();
}
