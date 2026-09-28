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

const credentials = { badge: "001", pin: "123456", sessionEpoch: "epoch-1" };

test("default login ends when browser session storage is cleared", () => {
  storage.clearAgent();
  storage.saveAgentCredentials(credentials);
  assert.deepEqual(storage.loadAgentCredentials(), credentials);
  assert.equal(localStorage.getItem(storage.STORAGE_KEYS.agentCredentials), null);
  globalThis.sessionStorage = createStorage();
  assert.equal(storage.loadAgentCredentials(), null);
});

test("remembered login survives browser closure and logout removes it", () => {
  storage.clearAgent();
  storage.saveAgentCredentials(credentials, true);
  assert.equal(sessionStorage.getItem(storage.STORAGE_KEYS.agentCredentials), null);
  globalThis.sessionStorage = createStorage();
  assert.deepEqual(storage.loadAgentCredentials(), credentials);
  storage.clearAgent();
  assert.equal(storage.loadAgentCredentials(), null);
});

test("login without remember me replaces previously remembered credentials", () => {
  storage.saveAgentCredentials(credentials, true);
  const nextCredentials = { ...credentials, badge: "002" };
  storage.saveAgentCredentials(nextCredentials, false);
  assert.deepEqual(storage.loadAgentCredentials(), nextCredentials);
  assert.equal(localStorage.getItem(storage.STORAGE_KEYS.agentCredentials), null);
  globalThis.sessionStorage = createStorage();
  assert.equal(storage.loadAgentCredentials(), null);
});

test("manager session reset removes remembered credentials", () => {
  storage.saveAgentCredentials(credentials, true);
  storage.clearAgentWorkspace();
  assert.equal(storage.loadAgentCredentials(), null);
  assert.equal(localStorage.getItem(storage.STORAGE_KEYS.agentCredentials), null);
});

test("global session reset clears agent identity, credentials, active tour and local history", () => {
  storage.saveAgent({ id: "agent-1", badge: "001" });
  storage.saveAgentCredentials({ badge: "001", pin: "123456", sessionEpoch: "epoch-1" });
  storage.saveActiveTour({ id: "tour-1", status: "active" });
  storage.saveTourHistory([{ id: "tour-old", status: "completed" }]);

  storage.clearAgentWorkspace();

  assert.equal(storage.loadAgent(), null);
  assert.equal(storage.loadAgentCredentials(), null);
  assert.equal(storage.loadActiveTour(), null);
  assert.deepEqual(storage.loadTourHistory(), []);
});
