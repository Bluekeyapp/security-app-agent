import test from "node:test";
import assert from "node:assert/strict";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

globalThis.localStorage = createStorage();
globalThis.sessionStorage = createStorage();
const storage = await import(`../src/storage.js?test=${Date.now()}`);

test("a new app version removes PINs persisted by older releases", () => {
  localStorage.setItem(storage.STORAGE_KEYS.agent, JSON.stringify({ badge: "001" }));
  localStorage.setItem(storage.STORAGE_KEYS.agentCredentials, JSON.stringify({ pin: "123456" }));
  sessionStorage.setItem(storage.STORAGE_KEYS.agentCredentials, JSON.stringify({ pin: "123456" }));
  storage.clearAgent();
  assert.equal(localStorage.getItem(storage.STORAGE_KEYS.agent), null);
  assert.equal(localStorage.getItem(storage.STORAGE_KEYS.agentCredentials), null);
  assert.equal(sessionStorage.getItem(storage.STORAGE_KEYS.agentCredentials), null);
});

test("signing out retains an unfinished patrol for reauthentication", () => {
  const tour = { id: "tour-1", status: "active" };
  storage.saveActiveTour(tour);
  storage.clearAgent();
  assert.deepEqual(storage.loadActiveTour(), tour);
});

test("global session reset clears active patrol and local history", () => {
  storage.saveActiveTour({ id: "tour-1", status: "active" });
  storage.saveTourHistory([{ id: "tour-old", status: "completed" }]);
  storage.clearAgentWorkspace();
  assert.equal(storage.loadActiveTour(), null);
  assert.deepEqual(storage.loadTourHistory(), []);
});
