import assert from "node:assert/strict";
import { test } from "node:test";
import { getHuangli } from "./huangli.ts";

test("calculates daily almanac without IPC", () => {
  const day = getHuangli(new Date(2026, 8, 28, 12));
  assert.equal(day.ganzhi, "丙午年 丁酉月 乙巳日");
  assert.equal(day.shengxiao, "马");
  assert.equal(day.xingzuo, "天秤座");
  assert.ok(day.yi.includes("嫁娶"));
  assert.ok(day.ji.includes("安葬"));
  assert.equal(day.zhushen, "朱雀");
  assert.equal(day.taishen, "碓磨床 房内东");
  assert.match(day.pengsheng, /乙不栽植.*巳不远行/);
});

test("uses the selected civil date across lunar new year", () => {
  const lastYear = getHuangli(new Date(2026, 1, 16, 12));
  const newYear = getHuangli(new Date(2026, 1, 17, 12));
  assert.notEqual(lastYear.shengxiao, newYear.shengxiao);
  assert.equal(newYear.shengxiao, "马");
  assert.ok(newYear.yi.length > 0);
  assert.ok(newYear.ji.length > 0);
});
