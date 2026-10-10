import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

test("countdown IPC uses the native contract and keeps credentials out of config snapshots", async () => {
  const source = await readFile(new URL("./countdownApi.ts", import.meta.url), "utf8");
  const mockUrl = `data:text/javascript;base64,${Buffer.from(`
    export const calls = [];
    export const invoke = async (command, args) => { calls.push({ command, args }); };
  `).toString("base64")}`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('"@tauri-apps/api/core"', JSON.stringify(mockUrl));
  const { countdownApi } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const { calls } = await import(mockUrl);

  await countdownApi.list();
  await countdownApi.save(null, "Reminder", 2030000000, "en");
  await countdownApi.save("event-id", "Edited", 2030000001, "zh");
  await countdownApi.delete("event-id");
  await countdownApi.config();
  assert.deepEqual(calls.splice(0), [
    { command: "countdown_list", args: undefined },
    { command: "countdown_save", args: { id: null, title: "Reminder", targetAt: 2030000000, language: "en" } },
    { command: "countdown_save", args: { id: "event-id", title: "Edited", targetAt: 2030000001, language: "zh" } },
    { command: "countdown_delete", args: { id: "event-id" } },
    { command: "notification_config_get", args: undefined },
  ]);

  const config = {
    bark_enabled: true, bark_server: "https://api.day.app", bark_configured: true,
    serverchan_enabled: false, serverchan_configured: true,
  };
  await countdownApi.saveConfig(config, null, "");
  await countdownApi.saveConfig(config, "new-device-key", "sctp123tNEW");
  assert.deepEqual(calls.splice(0), [
    { command: "notification_config_save", args: {
      config: { bark_enabled: true, bark_server: "https://api.day.app", serverchan_enabled: false },
      barkKey: null, serverchanKey: "",
    } },
    { command: "notification_config_save", args: {
      config: { bark_enabled: true, bark_server: "https://api.day.app", serverchan_enabled: false },
      barkKey: "new-device-key", serverchanKey: "sctp123tNEW",
    } },
  ]);
  for (const channel of ["system", "bark", "serverchan"]) await countdownApi.test(channel, "en");
  assert.deepEqual(calls.map((call) => call.args.channel), ["system", "bark", "serverchan"]);
  assert.ok(calls.every((call) => call.command === "notification_test" && call.args.language === "en"));
});
