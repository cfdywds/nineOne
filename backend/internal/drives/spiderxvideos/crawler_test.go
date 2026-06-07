package spiderxvideos

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/video-site/backend/internal/catalog"
)

func TestCrawlerRunOnceDownloadsAndUpserts(t *testing.T) {
	cat := openTestCatalog(t)
	var videoHits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/videos/12345.mp4":
			videoHits++
			_, _ = w.Write([]byte("fake-video-body"))
		case "/thumbs/12345.jpg":
			_, _ = w.Write([]byte("fake-jpeg-body"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	script := buildFakeSpiderScript(t, fmt.Sprintf(`{"title":"XVideos One","thumb_url":%q,"video_url":%q,"viewkey":"12345","video_id":"12345","detail_url":"https://www.xvideos.com/video12345/test"}`,
		srv.URL+"/thumbs/12345.jpg",
		srv.URL+"/videos/12345.mp4?token=ok",
	))

	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	commonThumbs := filepath.Join(t.TempDir(), "thumbs")
	crawler := NewCrawler(CrawlerConfig{
		Driver:          driver,
		Catalog:         cat,
		PythonPath:      script.runner,
		ScriptPath:      script.path,
		WorkDir:         filepath.Dir(script.path),
		CommonThumbDir:  commonThumbs,
		DownloadTimeout: 10 * time.Second,
		StartURL:        "https://www.xvideos.com/?k=test",
		Quality:         "best",
	})

	res, err := crawler.RunOnce(context.Background(), 1)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.NewVideos != 1 || res.TotalEntries != 1 || res.Failed != 0 {
		t.Fatalf("result = %#v, want one new video", res)
	}
	if videoHits != 1 {
		t.Fatalf("video hits = %d, want 1", videoHits)
	}
	v, err := cat.GetVideo(context.Background(), BuildVideoID("xv", "12345"))
	if err != nil {
		t.Fatalf("GetVideo: %v", err)
	}
	if v.Author != DefaultAuthor || v.FileID != "12345.mp4" || v.Ext != "mp4" {
		t.Fatalf("video = %#v", v)
	}
	if _, err := os.Stat(filepath.Join(root, "videos", "12345.mp4")); err != nil {
		t.Fatalf("video file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "thumbs", "12345.jpg")); err != nil {
		t.Fatalf("thumb file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(commonThumbs, v.ID+".jpg")); err != nil {
		t.Fatalf("common thumb missing: %v", err)
	}
}

func TestCrawlerRunOnceReportsProgressAndScriptLogs(t *testing.T) {
	cat := openTestCatalog(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/videos/12345.mp4":
			_, _ = w.Write([]byte("fake-video-body"))
		case "/thumbs/12345.jpg":
			_, _ = w.Write([]byte("fake-jpeg-body"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	jsonLine := fmt.Sprintf(`{"title":"XVideos One","thumb_url":%q,"video_url":%q,"viewkey":"12345","video_id":"12345","detail_url":"https://www.xvideos.com/video12345/test"}`,
		srv.URL+"/thumbs/12345.jpg",
		srv.URL+"/videos/12345.mp4",
	)
	script := buildFakeSpiderScriptWithStderr(t, jsonLine, "python parsed one item")

	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	var logs []string
	var progress []CrawlResult
	crawler := NewCrawler(CrawlerConfig{
		Driver:          driver,
		Catalog:         cat,
		PythonPath:      script.runner,
		ScriptPath:      script.path,
		WorkDir:         filepath.Dir(script.path),
		DownloadTimeout: 10 * time.Second,
		Quality:         "best",
		OnLog: func(line string) {
			logs = append(logs, line)
		},
		OnProgress: func(res CrawlResult) {
			progress = append(progress, res)
		},
	})

	res, err := crawler.RunOnce(context.Background(), 1)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.NewVideos != 1 || res.TotalEntries != 1 {
		t.Fatalf("result = %#v, want one parsed and downloaded video", res)
	}
	if len(logs) == 0 || !strings.Contains(logs[0], "python parsed one item") {
		t.Fatalf("logs = %#v, want script stderr forwarded", logs)
	}
	if len(progress) == 0 {
		t.Fatal("OnProgress was not called")
	}
	last := progress[len(progress)-1]
	if last.TotalEntries != 1 || last.NewVideos != 1 || last.TargetNew != 1 || last.OutputJSON == "" || last.SeenFile == "" {
		t.Fatalf("last progress = %#v, want live crawl counters and result paths", last)
	}
}

func TestCrawlerRunOnceMergesHLSWhenEnabled(t *testing.T) {
	cat := openTestCatalog(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/hls.m3u8":
			_, _ = w.Write([]byte("#EXTM3U\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	script := buildFakeSpiderScript(t, fmt.Sprintf(`{"title":"XVideos HLS","video_url":%q,"viewkey":"hls1","video_id":"hls1","detail_url":"https://www.xvideos.com/video.hls1/test"}`,
		srv.URL+"/hls.m3u8",
	))
	ffmpeg := buildFakeFFmpeg(t)

	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	crawler := NewCrawler(CrawlerConfig{
		Driver:          driver,
		Catalog:         cat,
		PythonPath:      script.runner,
		ScriptPath:      script.path,
		WorkDir:         filepath.Dir(script.path),
		DownloadTimeout: 10 * time.Second,
		Quality:         "best",
		MergeHLS:        true,
		FFmpegPath:      ffmpeg,
	})

	res, err := crawler.RunOnce(context.Background(), 1)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.NewVideos != 1 || res.Failed != 0 {
		t.Fatalf("result = %#v, want one merged video", res)
	}
	v, err := cat.GetVideo(context.Background(), BuildVideoID("xv", "hls1"))
	if err != nil {
		t.Fatalf("GetVideo: %v", err)
	}
	if v.FileID != "hls1.mp4" || v.Ext != "mp4" || v.Size <= 0 {
		t.Fatalf("video = %#v, want merged mp4", v)
	}
	if _, err := os.Stat(filepath.Join(root, "videos", "hls1.mp4")); err != nil {
		t.Fatalf("merged video missing: %v", err)
	}
}

func TestStartSpiderTargetNewPassesFilterArgs(t *testing.T) {
	cat := openTestCatalog(t)
	script := buildFakeSpiderScript(t, `{"title":"x","video_url":"https://example.com/v.mp4","viewkey":"1","video_id":"1","detail_url":"https://www.xvideos.com/video1/x"}`)
	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	crawler := NewCrawler(CrawlerConfig{
		Driver:      driver,
		Catalog:     cat,
		PythonPath:  script.runner,
		ScriptPath:  script.path,
		WorkDir:     filepath.Dir(script.path),
		StartURL:    "",
		Keyword:     "cat videos",
		Quality:     "best",
		MinSize:     "500MB",
		MaxSize:     "2GB",
		MinDuration: "60",
		MaxDuration: "600",
		MergeHLS:    true,
	})

	cmd, _, err := crawler.startSpiderTargetNew(context.Background(), 1, filepath.Join(root, "seen.txt"), filepath.Join(root, "out.json"))
	if err != nil {
		t.Fatalf("startSpiderTargetNew: %v", err)
	}
	args := strings.Join(cmd.Args, " ")
	for _, want := range []string{"--keyword", "cat videos", "--min-size", "500MB", "--max-size", "2GB", "--min-duration", "60", "--max-duration", "600", "--merge-hls"} {
		if !strings.Contains(args, want) {
			t.Fatalf("args = %q, want contain %q", args, want)
		}
	}
	assertEnvContains(t, cmd.Env, "PYTHONIOENCODING=utf-8")
	assertEnvContains(t, cmd.Env, "PYTHONUTF8=1")
	_ = cmd.Process.Kill()
}

func TestCrawlerKeywordBuildsSearchUrlWhenStartURLBlank(t *testing.T) {
	cat := openTestCatalog(t)
	script := buildFakeSpiderScript(t, `{"title":"x","video_url":"https://example.com/v.mp4","viewkey":"1","video_id":"1","detail_url":"https://www.xvideos.com/video1/x"}`)
	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	crawler := NewCrawler(CrawlerConfig{
		Driver:     driver,
		Catalog:    cat,
		PythonPath: script.runner,
		ScriptPath: script.path,
		WorkDir:    filepath.Dir(script.path),
		Keyword:    "cat videos",
	})

	cmd, _, err := crawler.startSpiderTargetNew(context.Background(), 1, filepath.Join(root, "seen.txt"), filepath.Join(root, "out.json"))
	if err != nil {
		t.Fatalf("startSpiderTargetNew: %v", err)
	}
	argText := strings.Join(cmd.Args, " ")
	if strings.Contains(argText, "--url") {
		t.Fatalf("args = %#v, want no --url when keyword is used", cmd.Args)
	}
	_ = cmd.Process.Kill()
}

func TestCrawlerPassesStartURLWhenPresent(t *testing.T) {
	cat := openTestCatalog(t)
	script := buildFakeSpiderScript(t, `{"title":"x","video_url":"https://example.com/v.mp4","viewkey":"1","video_id":"1","detail_url":"https://www.xvideos.com/video1/x"}`)
	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	crawler := NewCrawler(CrawlerConfig{
		Driver:     driver,
		Catalog:    cat,
		PythonPath: script.runner,
		ScriptPath: script.path,
		WorkDir:    filepath.Dir(script.path),
		StartURL:   "https://www.xvideos.com/?k=manual",
	})

	cmd, _, err := crawler.startSpiderTargetNew(context.Background(), 1, filepath.Join(root, "seen.txt"), filepath.Join(root, "out.json"))
	if err != nil {
		t.Fatalf("startSpiderTargetNew: %v", err)
	}
	argText := strings.Join(cmd.Args, " ")
	if !strings.Contains(argText, "--url") || !strings.Contains(argText, "https://www.xvideos.com/?k=manual") {
		t.Fatalf("args = %#v, want start url", cmd.Args)
	}
	_ = cmd.Process.Kill()
}

func TestCrawlerDefaultsStartURLOnlyWhenKeywordMissing(t *testing.T) {
	cat := openTestCatalog(t)
	script := buildFakeSpiderScript(t, `{"title":"x","video_url":"https://example.com/v.mp4","viewkey":"1","video_id":"1","detail_url":"https://www.xvideos.com/video1/x"}`)
	root := t.TempDir()
	driver := New(Config{ID: "xv", RootDir: root})
	crawler := NewCrawler(CrawlerConfig{
		Driver:     driver,
		Catalog:    cat,
		PythonPath: script.runner,
		ScriptPath: script.path,
		WorkDir:    filepath.Dir(script.path),
	})
	if crawler.cfg.StartURL != DefaultStartURL {
		t.Fatalf("start url = %q, want default %q", crawler.cfg.StartURL, DefaultStartURL)
	}
}

func openTestCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	cat, err := catalog.Open(filepath.Join(t.TempDir(), "video-site.db"))
	if err != nil {
		t.Fatalf("open catalog: %v", err)
	}
	t.Cleanup(func() { _ = cat.Close() })
	return cat
}

type fakeScript struct {
	runner string
	path   string
}

func buildFakeSpiderScript(t *testing.T, jsonLine string) fakeScript {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		path := filepath.Join(dir, "fake_spider.cmd")
		body := "@echo off\r\n" +
			"echo " + jsonLine + "\r\n"
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("write fake script: %v", err)
		}
		return fakeScript{runner: path, path: path}
	}
	path := filepath.Join(dir, "fake_spider.sh")
	body := "#!/bin/sh\nprintf '%s\\n' '" + strings.ReplaceAll(jsonLine, "'", "'\\''") + "'\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake script: %v", err)
	}
	return fakeScript{runner: path, path: path}
}

func buildFakeSpiderScriptWithStderr(t *testing.T, jsonLine, stderrLine string) fakeScript {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		path := filepath.Join(dir, "fake_spider.cmd")
		body := "@echo off\r\n" +
			"echo " + stderrLine + " 1>&2\r\n" +
			"echo " + jsonLine + "\r\n"
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("write fake script: %v", err)
		}
		return fakeScript{runner: path, path: path}
	}
	path := filepath.Join(dir, "fake_spider.sh")
	body := "#!/bin/sh\nprintf '%s\\n' '" + strings.ReplaceAll(stderrLine, "'", "'\\''") + "' >&2\nprintf '%s\\n' '" + strings.ReplaceAll(jsonLine, "'", "'\\''") + "'\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake script: %v", err)
	}
	return fakeScript{runner: path, path: path}
}

func buildFakeFFmpeg(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		path := filepath.Join(dir, "fake_ffmpeg.cmd")
		body := "@echo off\r\n" +
			"set out=%~1\r\n" +
			":loop\r\n" +
			"if \"%~2\"==\"\" goto write\r\n" +
			"shift\r\n" +
			"set out=%~1\r\n" +
			"goto loop\r\n" +
			":write\r\n" +
			"echo merged>%out%\r\n"
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("write fake ffmpeg: %v", err)
		}
		return path
	}
	path := filepath.Join(dir, "fake_ffmpeg.sh")
	body := "#!/bin/sh\nout=\"${@: -1}\"\nprintf '%s' merged > \"$out\"\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
	return path
}

func assertEnvContains(t *testing.T, env []string, want string) {
	t.Helper()
	for _, value := range env {
		if value == want {
			return
		}
	}
	t.Fatalf("env does not contain %q: %#v", want, env)
}
