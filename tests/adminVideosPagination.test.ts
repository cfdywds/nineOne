import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const videosPageSource = readFileSync(new URL("../src/admin/VideosPage.tsx", import.meta.url), "utf8");

test("admin videos page uses responsive page size", () => {
  assert.match(videosPageSource, /const DESKTOP_VIDEOS_PAGE_SIZE = 50;/);
  assert.match(videosPageSource, /const MOBILE_VIDEOS_PAGE_SIZE = 20;/);
  assert.match(videosPageSource, /const VIDEOS_MOBILE_QUERY = "\(max-width: 640px\)";/);
  assert.match(videosPageSource, /window\.matchMedia\(VIDEOS_MOBILE_QUERY\)/);
  assert.match(videosPageSource, /api\.listVideos\(\{ driveId, page, size: pageSize, keyword: searchKeyword \}\)/);
});

test("admin videos batch delete runs deletions sequentially", () => {
  assert.match(videosPageSource, /for \(const id of ids\) \{/);
  assert.match(videosPageSource, /const result = await api\.deleteVideo\(id, \{ deleteSource: batchDeleteSource \}\);/);
  assert.doesNotMatch(
    videosPageSource,
    /Promise\.allSettled\(\s*ids\.map\(\(id\) => api\.deleteVideo\(id(?:, [^)]+)?\)\)\s*\)/
  );
});

test("admin videos show generating status after preview regeneration is accepted", () => {
  assert.match(videosPageSource, /const REGEN_PREVIEW_STATUS = "generating";/);
  assert.match(videosPageSource, /const \[regenPreviewById, setRegenPreviewById\]/);
  assert.match(videosPageSource, /trackRegeneratingPreview\(\[v\]\)/);
  assert.match(videosPageSource, /<PreviewStatus s=\{isPreviewGenerating\(v\) \? REGEN_PREVIEW_STATUS : v\.previewStatus\} \/>/);
  assert.match(videosPageSource, /refreshListOnly\(\)/);
});

test("admin videos keep generating status after page refresh", () => {
  assert.match(videosPageSource, /const hasGeneratingPreview = list\.some\(\(v\) => v\.previewStatus === REGEN_PREVIEW_STATUS\);/);
  assert.match(videosPageSource, /if \(trackedRegenCount === 0 && !hasGeneratingPreview\) return;/);
  assert.match(videosPageSource, /function isPreviewGenerating\(v: api\.AdminVideo\)/);
  assert.match(videosPageSource, /return !!regenPreviewById\[v\.id\] \|\| v\.previewStatus === REGEN_PREVIEW_STATUS;/);
  assert.match(videosPageSource, /disabled=\{isPreviewGenerating\(v\)\}/);
});
