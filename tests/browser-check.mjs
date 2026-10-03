import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import { startTour } from "../src/patrol.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) throw new Error("Invalid path");
    const data = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const maliciousLabel = '<img src=x onerror="window.__xss=1">';
  const route = { siteId: "site-a", siteName: "Test site", points: [
    { id: "start", kind: "start", label: "Poste A", qrPayload: "START" },
    { id: "checkpoint", kind: "checkpoint", label: maliciousLabel, qrPayload: "CHECK" }
  ] };
  const active = startTour({ id: "a", badge: "A", name: "Agent A" }, "START", new Date(), null, route).tour;
  const history = [
    { ...active, id: "a-history", status: "completed", completedAt: new Date().toISOString(), comment: "A-only-comment" },
    { ...active, id: "b-history", agentId: "b", agentBadge: "B", status: "completed", completedAt: new Date().toISOString(), comment: "B-only-comment" }
  ];
  await context.addInitScript(({ active, history }) => {
    if (!localStorage.getItem("browser_fixture_seeded")) {
      localStorage.setItem("security_patrol_active_tour", JSON.stringify(active));
      localStorage.setItem("security_patrol_tour_history", JSON.stringify(history));
      localStorage.setItem("browser_fixture_seeded", "true");
    }
    navigator.geolocation.getCurrentPosition = (success) => success({ coords: { latitude: 18, longitude: -63, accuracy: 5 }, timestamp: Date.now() });
  }, { active, history });
  let allowSync = false;
  const invalidAgents = new Set();
  const sent = [];
  await page.route("**/src/agentRemoteStore.js*", async (intercept) => {
    await intercept.fulfill({ contentType: "text/javascript", body: `
      export async function authenticateAgent({badge}) { return {ok:true, agent:{id:badge.toLowerCase(),badge,name:'Agent '+badge,siteId:'site-a'},sessionEpoch:'epoch'}; }
      export async function resumeRememberedAgent(token) { return {ok:true,agent:{id:token.toLowerCase(),badge:token,name:'Agent '+token,siteId:'site-a'}}; }
      export async function revokeRememberedAgent() { return true; }
      export async function fetchAgentRoutes() { return {ok:true,routes:${JSON.stringify([route])}}; }
      export async function checkAgentSession(credentials) { return (await fetch('/__test/check',{method:'POST',body:JSON.stringify(credentials)})).json(); }
      export async function saveTourRemote(tour,credentials) { return (await fetch('/__test/sync',{method:'POST',body:JSON.stringify({tour,credentials})})).json(); }
    ` });
  });
  await page.route("**/__test/check", async (intercept) => {
    const credentials = intercept.request().postDataJSON();
    await intercept.fulfill({ json: { ok: true, valid: !invalidAgents.has(credentials.badge || credentials.token) } });
  });
  await page.route("**/__test/sync", async (intercept) => {
    const payload = intercept.request().postDataJSON();
    assert.equal(payload.tour.agentId, (payload.credentials.badge || payload.credentials.token).toLowerCase());
    sent.push(payload);
    await intercept.fulfill({ json: { ok: allowSync } });
  });
  const login = async (badge) => {
    await page.getByLabel("Matricule", { exact: true }).fill(badge);
    await page.getByLabel("Code PIN", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  };
  const records = () => page.evaluate(async () => (await import("/src/tourStore.js?v=1")).tourStore.all());
  const expire = async (badge) => {
    invalidAgents.add(badge);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByRole("heading", { name: "Connexion agent" }).waitFor();
  };

  await page.goto(origin);
  await login("A");
  await page.getByRole("button", { name: "Signaler" }).waitFor();
  assert.equal(await page.locator(".point-name").filter({ hasText: maliciousLabel }).count(), 1);
  assert.equal(await page.locator(".point-name img").count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  console.log("PASS: HTML checkpoint names are displayed as text.");

  await page.getByRole("button", { name: "Signaler" }).click();
  await page.locator("#incidentNote").fill("Photo of the gate");
  const imageBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    canvas.getContext("2d").fillRect(0, 0, 4, 4);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#incidentPhoto").setInputFiles({ name: "gate.png", mimeType: "image/png", buffer: Buffer.from(imageBase64, "base64") });
  await page.getByRole("button", { name: "Enregistrer le signalement", exact: true }).click();
  await page.getByText("Incident enregistré sur cet appareil", { exact: true }).waitFor();
  const incident = (await records()).find((record) => record.id === active.id).tour.incidents[0];
  assert.equal(incident.note, "Photo of the gate");
  assert.ok(incident.photoData.startsWith("data:image/jpeg;base64,"));
  console.log("PASS: incident photos are saved durably and remain available to the uploader.");

  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "tours") throw new DOMException("Quota full", "QuotaExceededError");
      return window.originalPut.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  await page.locator("#confirmCancelButton").click();
  await page.getByText("Enregistrement local impossible", { exact: false }).waitFor();
  assert.equal((await records()).find((record) => record.id === active.id).tour.status, "active");
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  await page.locator("#closeCancelButton").click();
  console.log("PASS: storage failure preserves the active patrol and reports no success.");

  await context.setOffline(true);
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  await page.locator("#confirmCancelButton").click();
  await page.getByRole("heading", { name: "Tournée annulée" }).waitFor();
  assert.equal((await records()).find((record) => record.id === active.id).pending, true);
  await context.setOffline(false);
  await page.reload();
  await login("B");
  await page.getByText("B-only-comment").waitFor();
  assert.equal(await page.getByText("A-only-comment").count(), 0);
  assert.equal((await records()).find((record) => record.id === active.id).tour.status, "cancelled");
  console.log("PASS: offline cancellation survives reload; agent B sees only B's records.");

  await expire("B");
  invalidAgents.delete("B");
  await login("A");
  await page.getByRole("button", { name: "Nouvelle tournée" }).waitFor();
  assert.equal(await page.getByText("B-only-comment").count(), 0);
  await expire("A");
  assert.equal((await records()).find((record) => record.id === active.id).pending, true);
  console.log("PASS: session expiry preserves unsent patrols.");

  invalidAgents.delete("A");
  await login("A");
  await page.getByText("Enregistré sur cet appareil · synchronisation en attente", { exact: true }).waitFor();
  allowSync = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Tournées synchronisées", { exact: true }).waitFor();
  assert.ok((await records()).filter((record) => record.tour.agentId === "a").every((record) => !record.pending));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Tournées synchronisées", { exact: true }).waitFor();
  console.log("PASS: reconnecting retries pending records successfully after reauthentication.");

  await page.evaluate(async (tour) => {
    await (await import("/src/tourStore.js?v=1")).tourStore.put({ ...tour, id: "remembered-active-a" });
    localStorage.setItem("security_patrol_remembered_session", JSON.stringify({ token: "B" }));
  }, active);
  await page.reload();
  await page.getByText("B-only-comment").waitFor();
  assert.equal(await page.getByRole("button", { name: "Signaler" }).count(), 0);
  assert.equal((await records()).find((record) => record.id === "remembered-active-a").tour.status, "active");
  await expire("B");
  invalidAgents.delete("B");
  await login("A");
  await page.getByRole("button", { name: "Signaler" }).waitFor();
  console.log("PASS: remembered login does not inherit another agent's active patrol.");

  await page.evaluate(() => {
    window.BarcodeDetector = class { async detect() { return [{ rawValue: window.testQr }]; } };
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
    HTMLMediaElement.prototype.play = async () => {};
    window.testQr = "CHECK";
  });
  await page.locator('[data-action="scan"]').click();
  await page.getByText("Retour Poste A requis", { exact: true }).waitFor();
  await page.evaluate(() => { window.testQr = "START"; });
  await page.locator('[data-action="scan"]').click();
  await page.locator('[name="tourComment"]').waitFor();
  await page.locator('[name="tourComment"]').fill("Final browser test comment");
  await page.locator('#commentForm button[type="submit"]').click();
  await page.getByText("Commentaire : Final browser test comment", { exact: true }).waitFor();
  const finished = (await records()).find((record) => record.id === "remembered-active-a").tour;
  assert.equal(finished.status, "completed");
  assert.equal(finished.comment, "Final browser test comment");
  assert.deepEqual(finished.scans.map((scan) => scan.type), ["start", "checkpoint", "close"]);
  console.log("PASS: scanning, completion and final comments commit successfully.");

  await page.getByRole("button", { name: "Nouvelle tournée" }).click();
  await page.evaluate(() => { window.testQr = "START"; });
  await page.locator('[data-action="scan"]').click();
  await page.getByRole("button", { name: "Signaler" }).waitFor();
  assert.equal((await records()).filter((record) => record.tour.agentId === "a" && record.tour.status === "active").length, 1);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `No horizontal overflow at ${width}px`);
    assert.ok(await page.locator("#syncStatus").isVisible());
  }
  console.log("PASS: starting a new patrol and sync status layout at 320, 390 and 1280px.");
  assert.deepEqual(errors, []);
  console.log("PASS: no browser runtime errors.");
  await context.close();
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
