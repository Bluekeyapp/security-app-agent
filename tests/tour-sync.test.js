import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createTourStore, migrateLegacyTours } from "../src/tourStore.js";
import { createTourSync, selectAgentTours } from "../src/tourSync.js";

const patrol = (id = "tour-a", agentId = "a", status = "active") => ({ id, agentId, status, startedAt: "2026-01-01", incidents: [] });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(send, options = {}) {
  const store = createTourStore(new IDBFactory());
  let session = { agentId: "a", credentials: { token: "a-token" } };
  const statuses = [];
  const sync = createTourSync({ store, send, getSession: () => session, onStatus: (status) => statuses.push(status), ...options });
  return { store, sync, statuses, setSession: (value) => { session = value; } };
}

test("a patrol and its separately stored photos survive reopening IndexedDB", async () => {
  const database = new IDBFactory();
  const store = createTourStore(database);
  const tour = { ...patrol(), incidents: [{ id: "incident", note: "Gate", photoData: "data:image/jpeg;base64,photo" }] };
  await store.put(tour);
  const reopened = createTourStore(database);
  const records = await reopened.all();
  assert.deepEqual(records[0].tour, tour);
  assert.equal(records[0].pending, true);
  const request = database.open("security-patrol-agent", 2);
  const db = await new Promise((resolve) => { request.onsuccess = () => resolve(request.result); });
  const stored = db.transaction("tours").objectStore("tours").get(tour.id);
  const raw = await new Promise((resolve) => { stored.onsuccess = () => resolve(stored.result); });
  assert.equal(raw.tour.incidents[0].photoData, undefined);
  assert.equal(raw.tour.incidents[0].photoId, "tour-a:incident");
  db.close();
});

test("an old upload acknowledgement cannot mark a newer revision synchronized", async () => {
  const store = createTourStore(new IDBFactory());
  const revision = await store.put(patrol());
  await store.put(patrol("tour-a", "a", "completed"));
  await store.markSynced("tour-a", revision);
  assert.equal((await store.all())[0].pending, true);
});

test("overlapping active, completed and commented updates upload in order", async () => {
  const started = deferred(), release = deferred();
  const sent = [];
  const { store, sync } = fixture(async (tour) => {
    sent.push(structuredClone(tour));
    if (sent.length === 1) { started.resolve(); await release.promise; }
    return { ok: true };
  });
  await sync.enqueue(patrol());
  const flushing = sync.flush();
  await started.promise;
  await sync.enqueue({ ...patrol("tour-a", "a", "completed"), comment: "Gate secured" });
  release.resolve();
  await flushing;
  assert.deepEqual(sent.map((tour) => tour.status), ["active", "completed"]);
  assert.equal(sent[1].comment, "Gate secured");
  assert.equal((await store.all())[0].pending, false);
});

test("failed and skipped uploads remain pending and retry successfully", async () => {
  let attempts = 0;
  const { store, sync } = fixture(async () => ++attempts === 1 ? { ok: false, skipped: true } : { ok: true });
  await sync.enqueue(patrol());
  await sync.flush();
  assert.equal((await store.all())[0].pending, true);
  await sync.flush();
  assert.equal((await store.all())[0].pending, false);
});

test("offline saves remain durable without attempting an upload", async () => {
  let online = false, attempts = 0;
  const { store, sync } = fixture(async () => { attempts++; return { ok: true }; }, { isOnline: () => online });
  await sync.enqueue(patrol());
  await sync.flush();
  assert.equal(attempts, 0);
  assert.equal((await store.all())[0].pending, true);
  online = true;
  await sync.flush();
  assert.equal(attempts, 1);
});

test("agent B cannot upload or restore agent A's records", async () => {
  const sent = [];
  const { store, sync, setSession } = fixture(async (tour) => { sent.push(tour.id); return { ok: true }; });
  await store.put(patrol("a-active"));
  await store.put(patrol("a-complete", "a", "completed"));
  await store.put(patrol("b-complete", "b", "completed"));
  setSession({ agentId: "b", credentials: { token: "b-token" } });
  await sync.flush();
  assert.deepEqual(sent, ["b-complete"]);
  const selected = selectAgentTours("b", await store.all());
  assert.equal(selected.activeTour, null);
  assert.deepEqual(selected.history.map((tour) => tour.id), ["b-complete"]);
});

test("session expiry preserves pending work for reauthentication", async () => {
  let rejected = false;
  const { store, sync, setSession } = fixture(async () => ({ ok: false, authRejected: true }), {
    onAuthRejected: () => { rejected = true; setSession(null); }
  });
  await sync.enqueue(patrol());
  await sync.flush();
  assert.equal(rejected, true);
  assert.equal((await store.all())[0].pending, true);
  assert.equal(selectAgentTours("a", await store.all()).activeTour.id, "tour-a");
});

test("a rejection for an old session does not sign out a newly logged-in agent", async () => {
  const started = deferred(), release = deferred();
  const rejected = [];
  const { store, sync, setSession } = fixture(async (tour) => {
    if (tour.agentId === "a") { started.resolve(); await release.promise; return { ok: false, authRejected: true }; }
    return { ok: true };
  }, { onAuthRejected: (id) => rejected.push(id) });
  await sync.enqueue(patrol());
  await sync.enqueue(patrol("b-tour", "b"));
  const flushing = sync.flush();
  await started.promise;
  setSession({ agentId: "b", credentials: { token: "b-token" } });
  release.resolve();
  await flushing;
  assert.deepEqual(rejected, []);
  assert.equal((await store.all()).find((record) => record.id === "b-tour").pending, false);
});

test("a failed local write rejects, performs no upload, and leaves the previous patrol intact", async () => {
  const store = createTourStore(new IDBFactory());
  await store.put(patrol());
  let attempts = 0;
  const sync = createTourSync({ store: { ...store, put: async () => { throw new Error("Quota exceeded"); } },
    send: async () => { attempts++; return { ok: true }; }, getSession: () => null });
  await assert.rejects(sync.enqueue(patrol("tour-a", "a", "completed")), /Quota/);
  assert.equal(attempts, 0);
  assert.equal((await store.all())[0].tour.status, "active");
});

test("unavailable storage fails explicitly", async () => {
  const store = createTourStore(null);
  await assert.rejects(store.put(patrol()), /IndexedDB unavailable/);
});

test("migration keeps legacy records until all writes commit and never overwrites newer records", async () => {
  const store = createTourStore(new IDBFactory());
  await store.put({ ...patrol(), comment: "new" });
  let cleaned = false;
  await migrateLegacyTours(store, [{ ...patrol(), comment: "old" }, patrol("tour-b", "b")], () => { cleaned = true; });
  assert.equal(cleaned, true);
  assert.equal((await store.all()).find((record) => record.id === "tour-a").tour.comment, "new");
  cleaned = false;
  await assert.rejects(migrateLegacyTours({ all: async () => [], put: async () => { throw new Error("Quota"); } }, [patrol()], () => { cleaned = true; }), /Quota/);
  assert.equal(cleaned, false);
});

test("history cleanup keeps every unsent patrol and each agent's active patrol", async () => {
  const store = createTourStore(new IDBFactory());
  for (let index = 0; index < 30; index++) {
    const revision = await store.put(patrol(`done-${index}`, "a", "completed"));
    await store.markSynced(`done-${index}`, revision);
  }
  await store.put(patrol("pending-old", "a", "completed"));
  await store.put(patrol("active"));
  await store.put(patrol("other", "b", "completed"));
  await store.prune("a");
  const records = await store.all();
  assert.equal(records.length, 28);
  for (const id of ["pending-old", "active", "other"]) assert.ok(records.some((record) => record.id === id));
});
