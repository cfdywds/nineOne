import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modalSource = readFileSync(
  new URL("../src/admin/Modal.tsx", import.meta.url),
  "utf8"
);

test("admin modal does not reset focus when close handler identity changes", () => {
  assert.match(modalSource, /const onCloseRef = useRef\(onClose\);/);
  assert.match(modalSource, /onCloseRef\.current = onClose;/);
  assert.match(modalSource, /onCloseRef\.current\(\);/);
  assert.match(modalSource, /window\.clearTimeout\(focusTimer\);/);
  assert.match(modalSource, /\}, \[open\]\);/);
  assert.doesNotMatch(modalSource, /\}, \[open, onClose\]\);/);
});
