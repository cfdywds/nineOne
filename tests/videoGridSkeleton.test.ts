import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const videoCardCss = readFileSync(
  new URL("../src/styles/video-card.css", import.meta.url),
  "utf8"
);

function ruleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test("home video skeleton uses theme-aware non-white shimmer colors", () => {
  const skeleton = ruleBody(videoCardCss, ".skeleton-card");
  const pink = ruleBody(videoCardCss, ':root[data-theme="pink"] .skeleton-card');
  const sky = ruleBody(videoCardCss, ':root[data-theme="sky"] .skeleton-card');
  const thumb = ruleBody(videoCardCss, ".skeleton-card::before");
  const text = ruleBody(videoCardCss, ".skeleton-card::after");

  assert.match(skeleton, /--skeleton-shimmer-base\s*:/);
  assert.match(skeleton, /--skeleton-shimmer-highlight\s*:/);
  assert.match(thumb, /var\(--skeleton-shimmer-base\)/);
  assert.match(thumb, /var\(--skeleton-shimmer-highlight\)/);
  assert.match(text, /var\(--skeleton-shimmer-base\)/);
  assert.match(text, /var\(--skeleton-shimmer-highlight\)/);

  assert.match(pink, /--skeleton-shimmer-base\s*:\s*rgba\(255,\s*91,\s*138,\s*0\.12\)/);
  assert.match(pink, /--skeleton-shimmer-highlight\s*:\s*rgba\(255,\s*91,\s*138,\s*0\.26\)/);
  assert.match(sky, /--skeleton-shimmer-base\s*:\s*rgba\(60,\s*100,\s*170,\s*0\.13\)/);
  assert.match(sky, /--skeleton-shimmer-highlight\s*:\s*rgba\(60,\s*100,\s*170,\s*0\.26\)/);
});
