import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function createClockStore() {
  const apiUrl = moduleUrl(`
    export const requests = [];
    export const worldTimeApi = {
      search: (query) => new Promise((resolve, reject) => requests.push({ query, resolve, reject })),
      clocks: async () => [
        { timezone: 'local', is_dst: true },
        { timezone: 'Asia/Tokyo', is_dst: false },
      ],
    };
    export const locationApi = {}, weatherApi = {};
  `);
  const settingsUrl = moduleUrl(`
    export const useSettingsStore = { getState: () => ({ modules: { worldClock: true } }) };
    export const syncRuntimePreferences = async () => {};
  `);
  const source = await readFile(new URL("../stores/infoStore.ts", import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [specifier, url] of [
    ["zustand", import.meta.resolve("zustand")],
    ["../services/ipc", apiUrl],
    ["./settingsStore", settingsUrl],
    ["../data/i18n", new URL("../data/i18n.ts", import.meta.url).href],
  ]) compiled = compiled.replaceAll(`"${specifier}"`, JSON.stringify(url));
  const { useInfoStore: store } = await import(moduleUrl(compiled));
  const { requests } = await import(apiUrl);
  return { store, requests };
}

test("clock search clears old results and only accepts the latest request", async () => {
  const { store, requests } = await createClockStore();
  store.setState({ searchResults: [{ label: "Old", timezone: "Old" }] });
  const first = store.getState().search("New York");
  assert.deepEqual(store.getState().searchResults, []);
  assert.equal(store.getState().searching, true);
  const second = store.getState().search("Tokyo");
  const tokyo = [{ label: "Tokyo", timezone: "Asia/Tokyo" }];
  requests[1].resolve(tokyo);
  await second;
  requests[0].resolve([{ label: "New York", timezone: "America/New_York" }]);
  await first;
  assert.deepEqual(store.getState().searchResults, tokyo);
  assert.equal(store.getState().searching, false);

  const stale = store.getState().search("older failure");
  const latest = store.getState().search("no match");
  requests[2].reject(new Error("stale"));
  await stale;
  assert.equal(store.getState().searching, true);
  requests[3].resolve([]);
  await latest;
  assert.deepEqual(store.getState().searchResults, []);

  store.setState({ searchResults: tokyo });
  const failed = store.getState().search("failure");
  requests[4].reject(new Error("IPC unavailable"));
  await assert.rejects(failed, /IPC unavailable/);
  assert.deepEqual(store.getState().searchResults, []);
  assert.equal(store.getState().searching, false);
});

test("local DST snapshot is kept separate from draggable saved clocks", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { hidden: false };
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  });
  const { store } = await createClockStore();
  await store.getState().loadClocks();
  assert.equal(store.getState().localClock.is_dst, true);
  assert.deepEqual(store.getState().clocks, [{ timezone: "Asia/Tokyo", is_dst: false }]);
});
