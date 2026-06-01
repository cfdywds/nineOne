# SpiderXVideos Filter and Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyword search, size/duration filtering, and optional HLS merge support to the spiderxvideos crawler, backend wiring, and admin form.

**Architecture:** Keep the Python spider responsible for search URL construction, metadata parsing, filter decisions, and source selection. Keep the Go crawler responsible for passing config, downloading selected sources, and optionally merging HLS with existing ffmpeg configuration. Keep the admin form thin: it only edits credentials/config values and sends them through the existing drive save path.

**Tech Stack:** Python 3, requests/bs4, Go, React/TypeScript, Node test runner.

---

### Task 1: Add Python parsing and filtering tests

**Files:**
- Modify: `tests/test_spider_xvideos.py`

- [ ] **Step 1: Write the failing test**

```python
def test_keyword_builds_xvideos_search_url():
    mod = load_spider_module()
    spider = mod.XVideosSpider(keyword="cat videos", no_download=True)
    assert spider.build_list_url(1) == "https://www.xvideos.com/?k=cat+videos"

def test_parse_human_sizes_and_durations_and_filter_unknowns():
    mod = load_spider_module()
    spider = mod.XVideosSpider(
        no_download=True,
        min_size="500MB",
        max_size="2GB",
        min_duration="01:00",
        max_duration="10:00",
    )
    assert spider.parse_size_limit("1.5GB") == 1610612736
    assert spider.parse_duration_limit("01:30") == 90
    assert spider.video_matches_filters({"video_size": 1000000000, "duration_seconds": 300})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_spider_xvideos.XVideosSpiderParserTests.test_keyword_builds_xvideos_search_url tests.test_spider_xvideos.XVideosSpiderParserTests.test_parse_human_sizes_and_durations_and_filter_unknowns -v`
Expected: fail because the spider does not yet accept `keyword` or parse these limits.

- [ ] **Step 3: Write minimal implementation**

Add helpers in `91VideoSpider/spider_xvideos.py` for keyword URL selection and limit parsing.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m unittest tests.test_spider_xvideos -v`
Expected: pass for the new parsing tests.

- [ ] **Step 5: Commit**

```bash
git add tests/test_spider_xvideos.py 91VideoSpider/spider_xvideos.py
git commit -m "test: add xvideos filter coverage"
```

### Task 2: Implement Python crawl filtering and source selection

**Files:**
- Modify: `91VideoSpider/spider_xvideos.py`
- Modify: `tests/test_spider_xvideos.py`

- [ ] **Step 1: Write the failing test**

```python
def test_best_quality_prefers_hls_only_when_merge_enabled():
    mod = load_spider_module()
    spider = mod.XVideosSpider(no_download=True, quality="best", merge_hls=False)
    sources = {"high": "https://cdn.example.com/high.mp4", "hls": "https://cdn.example.com/master.m3u8"}
    assert spider._choose_source(sources) == ("high", "https://cdn.example.com/high.mp4")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_spider_xvideos.XVideosSpiderParserTests.test_best_quality_prefers_hls_only_when_merge_enabled -v`
Expected: fail until merge-aware source selection exists.

- [ ] **Step 3: Write minimal implementation**

Add filter evaluation before append/download and merge-aware source ordering.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m unittest tests.test_spider_xvideos -v`
Expected: all Python spider tests pass.

- [ ] **Step 5: Commit**

```bash
git add 91VideoSpider/spider_xvideos.py tests/test_spider_xvideos.py
git commit -m "feat: filter and refine xvideos spider selection"
```

### Task 3: Wire new crawler credentials through backend and admin form

**Files:**
- Modify: `backend/cmd/server/main.go`
- Modify: `src/admin/DrivesPage.tsx`
- Modify: `tests/adminDriveForm.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
assert.match(drivesPageSource, /key: "keyword"/);
assert.match(drivesPageSource, /key: "min_size"/);
assert.match(drivesPageSource, /key: "max_duration"/);
assert.match(drivesPageSource, /key: "merge_hls"/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/adminDriveForm.test.ts`
Expected: fail because the new fields are missing.

- [ ] **Step 3: Write minimal implementation**

Add new spiderxvideos credential fields and pass them into `spiderxvideos.CrawlerConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/adminDriveForm.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go src/admin/DrivesPage.tsx tests/adminDriveForm.test.ts
git commit -m "feat: expose xvideos filter settings"
```

### Task 4: Add Go crawler tests for config passing and HLS merge branch

**Files:**
- Modify: `backend/internal/drives/spiderxvideos/crawler_test.go`
- Modify: `backend/internal/drives/spiderxvideos/crawler.go`

- [ ] **Step 1: Write the failing test**

```go
func TestStartSpiderTargetNewPassesKeywordAndFilters(t *testing.T) {
    // verify args include --keyword/--min-size/--merge-hls
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\\.tools\\go1.26.3\\go\\bin\\go.exe -C backend test ./internal/drives/spiderxvideos -run TestStartSpiderTargetNewPassesKeywordAndFilters -count=1`
Expected: fail because args are not passed yet.

- [ ] **Step 3: Write minimal implementation**

Pass new credentials into the Python command and add the merge branch in download logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `.\\.tools\\go1.26.3\\go\\bin\\go.exe -C backend test ./internal/drives/spiderxvideos -count=1`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/drives/spiderxvideos/crawler.go backend/internal/drives/spiderxvideos/crawler_test.go
git commit -m "feat: pass xvideos filter settings through crawler"
```

### Task 5: Verify full local coverage

**Files:**
- None

- [ ] **Step 1: Run Python tests**

Run: `python -m unittest tests.test_spider_xvideos -v`

- [ ] **Step 2: Run frontend tests**

Run: `node --test tests/adminDriveForm.test.ts`

- [ ] **Step 3: Run Go tests**

Run: `.\\.tools\\go1.26.3\\go\\bin\\go.exe -C backend test ./internal/drives/spiderxvideos ./cmd/server -count=1`

- [ ] **Step 4: Report remaining gaps**

List any failures with file and line context.
