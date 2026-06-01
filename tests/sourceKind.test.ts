import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const videoCardSource = readFileSync(
  new URL("../src/components/VideoCard.tsx", import.meta.url),
  "utf8"
);
const videoMetaHeaderSource = readFileSync(
  new URL("../src/components/VideoMetaHeader.tsx", import.meta.url),
  "utf8"
);
const videoCardCss = readFileSync(
  new URL("../src/styles/video-card.css", import.meta.url),
  "utf8"
);
const videoDetailCss = readFileSync(
  new URL("../src/styles/video-detail.css", import.meta.url),
  "utf8"
);

test("video source badges recognize xvideos crawler labels", () => {
  assert.match(videoCardSource, /includes\("xvideos"\)[\s\S]*return "spiderxvideos"/);
  assert.match(videoMetaHeaderSource, /includes\("xvideos"\)[\s\S]*return "spiderxvideos"/);
});

test("video source badge styles include spiderxvideos tone", () => {
  assert.match(videoCardCss, /data-kind="spiderxvideos"/);
  assert.match(videoDetailCss, /data-tone="spiderxvideos"/);
});
