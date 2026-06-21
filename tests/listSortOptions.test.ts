import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sortToolbarSource = readFileSync(
  new URL("../src/components/SortToolbar.tsx", import.meta.url),
  "utf8"
);
const typesSource = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");

test("list page sort toolbar only exposes active sort options", () => {
  assert.match(sortToolbarSource, /\{ key: "latest", label: "最新" \}/);
  assert.match(sortToolbarSource, /\{ key: "hot", label: "最热" \}/);
  assert.match(sortToolbarSource, /\{ key: "recent", label: "最近观看" \}/);

  for (const removed of ["本周", "最长", "高清", "精选"]) {
    assert.doesNotMatch(sortToolbarSource, new RegExp(removed));
  }
  assert.match(typesSource, /export type SortKey = "latest" \| "hot" \| "recent";/);
});
