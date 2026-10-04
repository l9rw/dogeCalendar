import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODULES, loadModulePreferences } from "./modulePreferences.ts";

test("new installations start with a local-only calendar", () => {
  assert.deepEqual(DEFAULT_MODULES, { weather: false, worldClock: false, almanac: false, network: false });
});

test("existing pre-module settings keep historical behavior", () => {
  assert.deepEqual(loadModulePreferences(undefined), { weather: true, worldClock: true, almanac: true, network: true });
});

test("existing choices are preserved and unexpected fields ignored", () => {
  assert.deepEqual(loadModulePreferences({ weather: false, network: false, almanac: true, extra: true }),
    { weather: false, worldClock: true, almanac: true, network: false });
  assert.equal(loadModulePreferences({ network: "false" }).network, true);
  assert.equal(DEFAULT_MODULES.network, false);
});
