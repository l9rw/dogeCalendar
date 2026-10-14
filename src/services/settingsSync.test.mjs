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
  const { useSettingsStore, effectiveAppearance, applyAppearance } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  assert.equal(useSettingsStore.getState().appearance.colorTheme, "classic");
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

  await t.test("old and invalid palette settings keep classic and existing custom colors", () => {
    const before = useSettingsStore.getState();
    const { colorTheme, ...appearance } = before.appearance;
    save({ ...saved(), appearance: { ...appearance, lightAccent: "#123456", darkBackground: "#121212" } });
    storageEvent("calendar-settings");
    const after = useSettingsStore.getState();
    assert.equal(after.appearance.colorTheme, "classic");
    assert.equal(after.appearance.lightAccent, "#123456");
    assert.equal(after.appearance.darkBackground, "#121212");
    const count = notifications;
    for (const invalid of ["unknown", "#123456", null, 42]) {
      save({ ...saved(), appearance: { ...after.appearance, colorTheme: invalid } });
      storageEvent("calendar-settings");
      assert.equal(useSettingsStore.getState().appearance, after.appearance);
      assert.equal(notifications, count);
    }
  });

  await t.test("presets apply both color modes without changing unrelated preferences", async () => {
    const { colorThemes } = await import("../data/colors.ts");
    assert.equal(colorThemes.length, 5);
    assert.equal(new Set(colorThemes.map((palette) => palette.id)).size, 5);
    useSettingsStore.getState().setGlassOpacity(43);
    for (const palette of colorThemes) {
      const before = useSettingsStore.getState();
      before.setColorTheme(palette.id);
      const after = useSettingsStore.getState();
      assert.equal(after.appearance.colorTheme, palette.id);
      for (const key of ["lightAccent", "lightBackground", "darkAccent", "darkBackground"]) {
        assert.equal(after.appearance[key], palette[key]);
      }
      assert.equal(after.appearance.glassOpacity, 43);
      for (const key of ["theme", "language", "calendar", "update", "modules", "ready", "launchAtLogin"]) {
        assert.equal(after[key], before[key]);
      }
      assert.deepEqual(saved().appearance, after.appearance);
    }
    const before = useSettingsStore.getState();
    before.setColorTheme("unknown");
    assert.equal(useSettingsStore.getState(), before);
  });

  await t.test("palette-only storage changes synchronize and hydrate preset defaults", () => {
    const before = useSettingsStore.getState();
    const count = notifications;
    save({ ...saved(), appearance: { ...before.appearance, colorTheme: "coral" } });
    storageEvent("calendar-settings");
    const after = useSettingsStore.getState();
    assert.equal(after.appearance.colorTheme, "coral");
    assert.equal(after.appearance.lightAccent, before.appearance.lightAccent);
    assert.equal(after.appearance.glassOpacity, before.appearance.glassOpacity);
    for (const key of ["theme", "calendar", "modules", "setColorTheme"]) assert.equal(after[key], before[key]);
    assert.equal(notifications, count + 1);
    window.dispatchEvent(new Event("focus"));
    assert.equal(notifications, count + 1);

    save({ ...saved(), appearance: { colorTheme: "emerald" } });
    storageEvent("calendar-settings");
    assert.equal(useSettingsStore.getState().appearance.lightBackground, "#F7FBFA");
    assert.equal(useSettingsStore.getState().appearance.darkAccent, "#2DD4BF");
  });

  await t.test("hidden auxiliary windows refresh a changed palette when shown or focused", () => {
    const before = useSettingsStore.getState();
    save({ ...saved(), appearance: { colorTheme: "indigo" } });
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(useSettingsStore.getState(), before);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(useSettingsStore.getState().appearance.colorTheme, "indigo");
    save({ ...saved(), appearance: { colorTheme: "cobalt" } });
    window.dispatchEvent(new Event("focus"));
    assert.equal(useSettingsStore.getState().appearance.colorTheme, "cobalt");
  });

  await t.test("custom colors survive color-mode changes and can restore their palette", () => {
    const store = useSettingsStore.getState();
    store.setGlassOpacity(43);
    store.setColorTheme("coral");
    store.setAccent("#ABCDEF", false);
    store.setBackground("#101010", true);
    const appearance = useSettingsStore.getState().appearance;
    assert.equal(appearance.colorTheme, "coral");
    assert.equal(saved().appearance.lightAccent, "#ABCDEF");
    for (const mode of ["light", "dark", "system"]) {
      useSettingsStore.getState().setTheme(mode);
      assert.equal(useSettingsStore.getState().appearance, appearance);
    }
    assert.deepEqual(effectiveAppearance("system", false, appearance), { dark: false, accent: "#ABCDEF", background: "#FAF8F6" });
    assert.deepEqual(effectiveAppearance("system", true, appearance), { dark: true, accent: "#FB7152", background: "#101010" });
    useSettingsStore.getState().setColorTheme(appearance.colorTheme);
    assert.equal(useSettingsStore.getState().appearance.lightAccent, "#E14D2A");
    assert.equal(useSettingsStore.getState().appearance.darkBackground, "#161312");
  });

  await t.test("initial and runtime appearance share the same root palette variables", () => {
    const properties = new Map();
    document.documentElement = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } };
    const appearance = useSettingsStore.getState().appearance;
    applyAppearance("system", false, appearance);
    assert.equal(document.documentElement.dataset.theme, "light");
    assert.equal(document.documentElement.dataset.colorTheme, "coral");
    assert.equal(properties.get("--blue"), "#E14D2A");
    assert.equal(properties.get("--shell-bg"), "#FAF8F6");
    assert.equal(properties.get("--glass-opacity"), "43%");
    applyAppearance("system", true, appearance);
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(properties.get("--blue"), "#FB7152");
    assert.equal(properties.get("--shell-bg"), "#161312");
  });

  await t.test("every color theme and appearance control has bilingual labels", async () => {
    const { colorThemes } = await import("../data/colors.ts");
    const { translator } = await import("../data/i18n.ts");
    for (const language of ["zh_CN", "en_US"]) {
      const { t } = translator(language);
      for (const palette of colorThemes) {
        for (const key of [`colorTheme.${palette.id}`, `colorTheme.${palette.id}.desc`]) assert.notEqual(t(key), key);
      }
      for (const key of ["appearance.colorTheme", "appearance.colorTheme.desc", "appearance.default", "appearance.resetPalette", "appearance.livePreview", "appearance.openFailed"]) assert.notEqual(t(key), key);
    }
  });
});
