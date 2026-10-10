import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

test("settings synchronize across windows without redundant notifications", async (t) => {
  const originals = new Map(["window", "document", "localStorage"].map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key),
  ]));
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const storage = new Map();
  Object.assign(globalThis, {
    window,
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  const source = await readFile(new URL("../stores/settingsStore.ts", import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const specifier of ["zustand", "zustand/vanilla/shallow", "@tauri-apps/api/core", "../data/colors", "../data/i18n", "../services/modulePreferences"]) {
    const resolved = specifier.startsWith(".")
      ? new URL(`${specifier}.ts`, import.meta.url).href
      : import.meta.resolve(specifier);
    compiled = compiled.replaceAll(`"${specifier}"`, JSON.stringify(resolved));
  }
  const { useSettingsStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  useSettingsStore.getState().setTheme("dark");
  let notifications = 0;
  const unsubscribe = useSettingsStore.subscribe(() => notifications++);
  t.after(unsubscribe);
  const saved = () => JSON.parse(storage.get("calendar-settings"));
  const save = (value) => storage.set("calendar-settings", JSON.stringify(value));
  const storageEvent = (key) => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: key });
    window.dispatchEvent(event);
  };

  await t.test("unchanged focus and visibility keep the state and references", () => {
    const before = useSettingsStore.getState();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    storageEvent("calendar-settings");
    assert.equal(notifications, 0);
    assert.equal(useSettingsStore.getState(), before);
  });

  await t.test("language changes preserve unrelated preferences and actions", () => {
    const before = useSettingsStore.getState();
    save({ ...saved(), language: "en_US" });
    storageEvent("calendar-settings");
    const after = useSettingsStore.getState();
    assert.equal(notifications, 1);
    assert.equal(after.language, "en_US");
    for (const key of ["appearance", "calendar", "update", "modules", "setTheme", "ready", "launchAtLogin"]) {
      assert.equal(after[key], before[key]);
    }
    window.dispatchEvent(new Event("focus"));
    assert.equal(notifications, 1);
  });

  await t.test("hidden windows defer visibility sync and refresh when shown", () => {
    const before = useSettingsStore.getState();
    const value = saved();
    value.calendar.weekStart = 0;
    save(value);
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(useSettingsStore.getState(), before);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    const after = useSettingsStore.getState();
    assert.equal(after.calendar.weekStart, 0);
    assert.notEqual(after.calendar, before.calendar);
    assert.equal(after.appearance, before.appearance);
    assert.equal(notifications, 2);
  });

  await t.test("storage clear restores defaults and unrelated keys do not sync", () => {
    save({ ...saved(), theme: "light" });
    storageEvent("unrelated-key");
    assert.equal(useSettingsStore.getState().theme, "dark");
    storage.clear();
    storageEvent(null);
    assert.equal(useSettingsStore.getState().theme, "system");
    assert.equal(useSettingsStore.getState().language, "system");
    assert.equal(useSettingsStore.getState().calendar.weekStart, 1);
    assert.equal(notifications, 3);
  });

  await t.test("focus recovers missed storage changes without disturbing OS state", () => {
    useSettingsStore.getState().hydrateLaunchAtLogin(true);
    const before = useSettingsStore.getState();
    const count = notifications;
    save({
      theme: before.theme,
      language: before.language,
      appearance: { ...before.appearance, glassOpacity: 60 },
      calendar: before.calendar,
      update: { ...before.update, autoCheck: false },
      modules: before.modules,
    });
    window.dispatchEvent(new Event("focus"));
    const after = useSettingsStore.getState();
    assert.equal(after.appearance.glassOpacity, 60);
    assert.equal(after.update.autoCheck, false);
    assert.equal(after.calendar, before.calendar);
    assert.equal(after.launchAtLogin, true);
    assert.equal(after.ready, true);
    assert.equal(after.setAccent, before.setAccent);
    assert.equal(notifications, count + 1);
    window.dispatchEvent(new Event("focus"));
    assert.equal(notifications, count + 1);
  });

  await t.test("module preferences synchronize without replacing unrelated settings", () => {
    const before = useSettingsStore.getState();
    const count = notifications;
    save({ ...saved(), modules: { ...before.modules, weather: !before.modules.weather } });
    storageEvent("calendar-settings");
    const after = useSettingsStore.getState();
    assert.equal(after.modules.weather, !before.modules.weather);
    assert.notEqual(after.modules, before.modules);
    for (const key of ["appearance", "calendar", "update"]) assert.equal(after[key], before[key]);
    window.dispatchEvent(new Event("focus"));
    assert.equal(notifications, count + 1);
  });
});
