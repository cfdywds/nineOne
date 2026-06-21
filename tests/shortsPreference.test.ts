import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shortsPageSource = readFileSync(
  new URL("../src/pages/ShortsPage.tsx", import.meta.url),
  "utf8"
);
const shortsCssSource = readFileSync(
  new URL("../src/styles/shorts.css", import.meta.url),
  "utf8"
);
const videosDataSource = readFileSync(
  new URL("../src/data/videos.ts", import.meta.url),
  "utf8"
);

test("shorts does not keep recommendation preference from likes or watch time", () => {
  assert.doesNotMatch(shortsPageSource, /currentTime\s*>=\s*3/);
  assert.doesNotMatch(shortsPageSource, /onPreferenceReady/);
  assert.doesNotMatch(shortsPageSource, /preferredFromVideoId/);
  assert.doesNotMatch(videosDataSource, /preferredFromVideoId/);

  const match = /const handleLikeToggle[\s\S]*?const hasLiked/.exec(
    shortsPageSource
  );
  assert.ok(match, "handleLikeToggle block should be present");

  assert.doesNotMatch(match[0], /preferred/i);
  assert.match(videosDataSource, /body: JSON\.stringify\(\{ seenIds, count \}\)/);
});

test("shorts progress dragging uses immediate pointer state", () => {
  assert.match(shortsPageSource, /const scrubbingRef = useRef\(false\)/);
  assert.match(shortsPageSource, /scrubbingRef\.current = true;/);
  assert.match(shortsPageSource, /if \(!scrubbingRef\.current\) return;/);
  assert.doesNotMatch(shortsPageSource, /if \(!scrubbing\) return;/);
  assert.match(shortsPageSource, /function getSeekDuration/);
  assert.match(shortsPageSource, /onLostPointerCapture=\{handleProgressPointerEnd\}/);
});

test("shorts progress listeners rebind when deferred videos mount", () => {
  assert.match(
    shortsPageSource,
    /VIDEO_WINDOW_SIZE 会让窗口外的 slide 先以海报占位/
  );
  assert.match(shortsPageSource, /if \(!shouldMount\) \{\s*setDuration\(0\);\s*setCurrentTime\(0\);/);
  assert.match(
    shortsPageSource,
    /\}, \[shouldMount, shouldLoad, item\.id, index, isActive, muted, volume, setMuted, setVolume, onActiveReadyForPreload, onActiveNeedsPriority, onSourceCached, isVideoPausedByUser\]\);/
  );
});

test("shorts paused overlay follows native video playback events", () => {
  assert.match(
    shortsPageSource,
    /const handlePlay = \(\) => \{[\s\S]*?if \(isVideoPausedByUser\(index\)\) \{[\s\S]*?video\.pause\(\);[\s\S]*?setPaused\(true\);[\s\S]*?return;[\s\S]*?setPaused\(false\);/
  );
  assert.match(
    shortsPageSource,
    /const handlePause = \(\) => \{[\s\S]*?if \(!isActive \|\| video\.ended\) return;[\s\S]*?setPaused\(true\);[\s\S]*?setIsBuffering\(false\);/
  );
  assert.match(shortsPageSource, /video\.addEventListener\("play", handlePlay\);/);
  assert.match(shortsPageSource, /video\.addEventListener\("pause", handlePause\);/);
  assert.match(shortsPageSource, /video\.removeEventListener\("play", handlePlay\);/);
  assert.match(shortsPageSource, /video\.removeEventListener\("pause", handlePause\);/);
});

test("shorts preserves a user pause while the active video is still loading", () => {
  assert.match(shortsPageSource, /const userPausedIndexRef = useRef<number \| null>\(null\);/);
  assert.match(shortsPageSource, /const \[userPausedIndex, setUserPausedIndexState\] = useState<number \| null>\(null\);/);
  assert.match(shortsPageSource, /const setUserPausedForIndex = useCallback/);
  assert.match(
    shortsPageSource,
    /if \(userPausedIndex === idx\) \{\s*if \(!video\.paused\) video\.pause\(\);\s*\} else if \(video\.paused\) \{\s*video\.play\(\)\.catch/
  );
  assert.match(
    shortsPageSource,
    /userPausedIndexRef\.current === activeIndex \|\|\s*\(activeVideo\.paused && activeVideo\.readyState >= 3\)/
  );
  assert.match(
    shortsPageSource,
    /setUserPausedForIndex\(activeIndex, false\);\s*activeVideo\.play\(\)\.catch/
  );
  assert.match(
    shortsPageSource,
    /setUserPausedForIndex\(activeIndex, true\);\s*activeVideo\.pause\(\);/
  );
  assert.match(
    shortsPageSource,
    /const shouldResume =\s*isVideoPausedByUser\(index\) \|\| \(video\.paused && paused && !isBuffering\);/
  );
  assert.match(
    shortsPageSource,
    /onUserPausedChange\(index, true\);\s*video\.pause\(\);\s*setPaused\(true\);\s*setIsBuffering\(false\);/
  );
  assert.match(
    shortsPageSource,
    /const handlePlayingOrCanPlay = \(\) => \{[\s\S]*?if \(isActive && isVideoPausedByUser\(index\)\) \{[\s\S]*?video\.pause\(\);[\s\S]*?setPaused\(true\);[\s\S]*?return;/
  );
});

test("shorts keyboard play pause does not show a toast", () => {
  const keyboardBlock = /else if \(e\.key === " "\) \{[\s\S]*?\} else if \(e\.key === "m"/.exec(shortsPageSource);
  assert.ok(keyboardBlock, "space key handler should be present");
  assert.doesNotMatch(keyboardBlock[0], /showHud\("播放"|showHud\("暂停"/);
});

test("shorts play pause does not render transient center hud", () => {
  assert.doesNotMatch(shortsPageSource, /function shouldShowPlayPauseHud\(\)/);
  assert.doesNotMatch(shortsPageSource, /setPlayPauseHud/);
  assert.doesNotMatch(shortsPageSource, /playPauseHud/);
  assert.doesNotMatch(shortsPageSource, /shorts-slide__hud-pulse/);
  assert.doesNotMatch(shortsCssSource, /\.shorts-slide__hud-pulse/);
  assert.doesNotMatch(shortsCssSource, /@keyframes shorts-hud-pop/);
  assert.match(
    shortsPageSource,
    /\{paused && isActive && !scrubbing && \(\s*<div className="shorts-slide__paused"/
  );
});

test("shorts hud toast keeps icon and text close together", () => {
  assert.match(
    shortsCssSource,
    /\.shorts-hud-toast\s*\{[\s\S]*gap:\s*4px;/
  );
});

test("shorts loading spinner uses a dedicated animated ring", () => {
  assert.match(shortsPageSource, /function ShortsLoadingSpinner/);
  assert.match(shortsPageSource, /requestAnimationFrame\(tick\)/);
  assert.match(shortsPageSource, /spinner\.style\.transform = `rotate\(\$\{rotation\}deg\)`;/);
  assert.match(shortsPageSource, /"--shorts-spinner-size": `\$\{size\}px`/);
  assert.match(shortsPageSource, /<ShortsLoadingSpinner size=\{30\} \/>/);
  assert.doesNotMatch(shortsPageSource, /<ShortsLoadingSpinner size=\{16\} \/>/);
  assert.doesNotMatch(shortsPageSource, /加载中…/);
  assert.doesNotMatch(shortsPageSource, /className="shorts-loading"/);
  assert.match(
    shortsCssSource,
    /\.shorts-slide__loading-spinner\s*\{[\s\S]*width:\s*var\(--shorts-spinner-size,\s*30px\);[\s\S]*height:\s*var\(--shorts-spinner-size,\s*30px\);[\s\S]*border:\s*3px solid rgba\(255,\s*255,\s*255,\s*0\.24\);[\s\S]*border-top-color:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);[\s\S]*border-radius:\s*50%;/
  );
  assert.doesNotMatch(shortsCssSource, /\.shorts-loading\s*\{/);
  assert.doesNotMatch(shortsCssSource, /\.shorts-loading \.shorts-slide__loading-spinner/);
  assert.match(
    shortsCssSource,
    /@media \(max-width:\s*640px\)\s*\{[\s\S]*\.shorts-slide__buffering\s*\{[\s\S]*--shorts-spinner-size:\s*24px;[\s\S]*width:\s*56px;[\s\S]*height:\s*56px;/
  );
});

test("shorts preloads the next two original videos only after the active video has comfortable buffer", () => {
  assert.match(shortsPageSource, /const \[activeReadyForPreload, setActiveReadyForPreload\] = useState\(false\);/);
  assert.match(shortsPageSource, /const ACTIVE_PRELOAD_BUFFER_SECONDS = 12;/);
  assert.match(shortsPageSource, /const PRELOAD_AHEAD_COUNT = 2;/);
  assert.match(
    shortsPageSource,
    /const preloadOffset = index - activeIndex;[\s\S]*?preloadOffset > 0 &&[\s\S]*?preloadOffset <= PRELOAD_AHEAD_COUNT;/
  );
  assert.match(shortsPageSource, /const shouldLoad = isActiveSlide \|\| shouldPreload \|\| shouldRetainCached;/);
  assert.match(shortsPageSource, /shouldLoad=\{shouldLoad\}/);
  assert.match(shortsPageSource, /setActiveReadyForPreload\(false\);\s*setActiveIndex\(bestIndex\);/);
  assert.match(shortsPageSource, /function syncActivePreloadReadiness\(currentVideo: HTMLVideoElement\)/);
  assert.match(shortsPageSource, /if \(videoHasComfortableBuffer\(currentVideo\)\) \{\s*onActiveReadyForPreload\(index\);/);
  assert.match(shortsPageSource, /if \(isActive\) onActiveNeedsPriority\(index\);/);
  assert.match(shortsPageSource, /video\.addEventListener\("progress", handleProgress\);/);
  assert.match(shortsPageSource, /src=\{shouldLoad \? item\.videoSrc : undefined\}/);
  assert.match(shortsPageSource, /video\.removeAttribute\("src"\)/);
  assert.doesNotMatch(shortsPageSource, /src=\{shouldLoad \? item\.previewSrc/);
});

test("shorts preload grant uses high/low watermark hysteresis", () => {
  // 高水位 12s 授权、低水位 4s 收回，之间维持现状，避免阈值附近抖动
  assert.match(shortsPageSource, /const ACTIVE_PRELOAD_KEEP_SECONDS = 4;/);
  assert.match(
    shortsPageSource,
    /\} else if \(videoBufferIsCritical\(currentVideo\)\) \{[\s\S]*?onActiveNeedsPriority\(index\);/
  );
  assert.match(shortsPageSource, /function videoBufferIsCritical\(video: HTMLVideoElement\)/);
  // 已缓冲到片尾时既视为健康也不视为告急，避免临近结尾误收回授权
  assert.match(shortsPageSource, /function videoBufferedToEnd\(video: HTMLVideoElement\)/);
  assert.match(
    shortsPageSource,
    /if \(videoBufferedToEnd\(video\)\) return true;[\s\S]*?>= ACTIVE_PRELOAD_BUFFER_SECONDS;/
  );
  assert.match(
    shortsPageSource,
    /if \(videoBufferedToEnd\(video\)\) return false;[\s\S]*?< ACTIVE_PRELOAD_KEEP_SECONDS;/
  );
});

test("shorts waits for the queue end before starting a new seen round", () => {
  assert.match(
    shortsPageSource,
    /if \(roundComplete\) \{[\s\S]*?if \(remaining > 0\) return;[\s\S]*?seenIdsRef\.current = \[\];[\s\S]*?saveSeenIds\(\[\]\);/
  );
});

test("shorts keeps buffered sources inside a six video window", () => {
  assert.match(shortsPageSource, /const \[cacheableSourceIds, setCacheableSourceIds\] = useState<Set<string>>/);
  assert.match(shortsPageSource, /setCacheableSourceIds\(\(prev\) => \{/);
  assert.match(shortsPageSource, /const VIDEO_WINDOW_SIZE = 6;/);
  assert.doesNotMatch(shortsPageSource, /VIDEO_WINDOW_BACKWARD_BIAS/);
  assert.match(shortsPageSource, /const \[cacheWindowHighIndex, setCacheWindowHighIndex\] = useState\(-1\);/);
  assert.match(shortsPageSource, /setCacheWindowHighIndex\(\(prev\) => Math\.max\(prev, activeIndex\)\);/);
  assert.match(shortsPageSource, /function getVideoWindowBounds\(highestViewedIndex: number, itemCount: number\)/);
  assert.match(
    shortsPageSource,
    /const videoWindow = getVideoWindowBounds\(cacheWindowHighIndex, items\.length\);/
  );
  assert.match(
    shortsPageSource,
    /const isInCacheWindow =\s*index >= videoWindow\.start && index <= videoWindow\.end;/
  );
  assert.match(
    shortsPageSource,
    /const shouldMount = isActiveSlide \|\| isInCacheWindow \|\| shouldPreload;/
  );
  // 视频窗口内已缓冲过的视频都保留 src，来回切换均复用缓存
  assert.match(
    shortsPageSource,
    /const shouldRetainCached =\s*isInCacheWindow && !isActiveSlide && cacheableSourceIds\.has\(item\.id\);/
  );
  // 窗口内视频一旦 canplay 就标记可复用，快速划走的视频回滑也有缓存
  assert.match(
    shortsPageSource,
    /if \(shouldLoad\) onSourceCached\(item\.id\);/
  );
  // 窗口内视频只要已经产生缓冲就同样标记，授权收回时不丢弃其数据
  assert.match(
    shortsPageSource,
    /if \(shouldLoad && videoHasBufferedData\(video\)\) \{\s*onSourceCached\(item\.id\);/
  );
  const playbackBlock = /\/\/ 控制每个 video 的播放状态[\s\S]*?\}, \[activeIndex, items\.length, userPausedIndex\]\);/.exec(shortsPageSource);
  assert.ok(playbackBlock, "parent playback effect should be present");
  assert.doesNotMatch(playbackBlock[0], /currentTime\s*=\s*0/);
  assert.doesNotMatch(playbackBlock[0], /video\.muted|video\.volume|applyVideoAudioState/);
  assert.match(shortsPageSource, /shouldEagerLoad=\{shouldEagerLoad\}/);
  assert.match(shortsPageSource, /preload=\{shouldLoad \? \(shouldEagerLoad \? "auto" : "metadata"\) : "none"\}/);
});

test("shorts volume changes do not trigger playback control", () => {
  assert.match(shortsPageSource, /function applyVideoAudioState/);
  assert.doesNotMatch(shortsPageSource, /onFirstPointer/);
  assert.doesNotMatch(shortsPageSource, /currentPage\.addEventListener\("pointerdown"/);
  assert.match(
    shortsPageSource,
    /const stopHeaderControlPropagation = useCallback\(\(e: React\.SyntheticEvent\) => \{\s*e\.stopPropagation\(\);/
  );
  assert.match(shortsPageSource, /onPointerDownCapture=\{stopHeaderControlPropagation\}/);
  assert.match(shortsPageSource, /onTouchStartCapture=\{stopHeaderControlPropagation\}/);
  assert.match(shortsPageSource, /onPointerDown=\{stopHeaderControlPropagation\}/);
  assert.match(shortsPageSource, /onTouchStart=\{stopHeaderControlPropagation\}/);
  assert.match(shortsPageSource, /function normalizeVideoPlaybackRate/);
  assert.match(shortsPageSource, /function stabilizeVideoAfterAudioToggle/);
  assert.match(shortsPageSource, /normalizeVideoPlaybackRate\(activeVideo\);/);
  assert.match(shortsPageSource, /videoRefs\.current\.get\(activeIndexRef\.current\) === activeVideo/);
  assert.match(shortsPageSource, /stabilizeVideoAfterAudioToggle\(\s*activeVideo,\s*\(\) => wasPlaying && canResumeActiveVideo\(\)\s*\);/);
  assert.match(shortsPageSource, /if \(shouldResume\(\) && video\.paused && !video\.ended\) \{/);
  assert.match(shortsPageSource, /for \(const delay of \[80, 240, 600\]\)/);
  assert.match(
    shortsPageSource,
    /useEffect\(\(\) => \{\s*videoRefs\.current\.forEach\(\(video\) => \{\s*applyVideoAudioState\(video, muted, volume\);/
  );
  assert.match(shortsPageSource, /\}, \[muted, volume, items\.length\]\);/);
});

test("shorts fullscreen changes preserve the active slide", () => {
  assert.match(shortsPageSource, /const activeIndexRef = useRef\(0\)/);
  assert.match(shortsPageSource, /const ignoreIntersectionUntilRef = useRef\(0\)/);
  assert.match(
    shortsPageSource,
    /if \(Date\.now\(\) < ignoreIntersectionUntilRef\.current\) return;/
  );
  assert.match(shortsPageSource, /function scheduleFullscreenActiveRestore\(\)/);
  assert.match(shortsPageSource, /scheduleFullscreenActiveRestore\(\);\s*setIsFullscreen/);
  assert.match(
    shortsPageSource,
    /function toggleFullscreen\(\) \{\s*scheduleFullscreenActiveRestore\(\);\s*if \(canRequestFullscreen\) \{/
  );
  assert.match(shortsPageSource, /if \(useDocumentScroll\) \{\s*restoreActiveSlideIntoView\(\);/);
  assert.match(shortsPageSource, /scrollIntoView\(\{ block: "start", inline: "nearest", behavior: "auto" \}\)/);
});
