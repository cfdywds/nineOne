package spiderxvideos

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDriverInitListStatStreamURL(t *testing.T) {
	root := t.TempDir()
	d := New(Config{ID: "xv", RootDir: root})
	if d.Kind() != Kind {
		t.Fatalf("Kind() = %q, want %q", d.Kind(), Kind)
	}
	if d.RootID() != "/" {
		t.Fatalf("RootID() = %q, want /", d.RootID())
	}
	if err := d.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	videoPath, err := d.VideoPath("12345.mp4")
	if err != nil {
		t.Fatalf("VideoPath: %v", err)
	}
	if err := os.WriteFile(videoPath, []byte("video"), 0o644); err != nil {
		t.Fatalf("write video: %v", err)
	}

	entries, err := d.List(context.Background(), "/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 || entries[0].ID != "12345.mp4" || entries[0].Size != 5 {
		t.Fatalf("entries = %#v, want one 12345.mp4 size=5", entries)
	}
	st, err := d.Stat(context.Background(), "12345.mp4")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if st.Name != "12345.mp4" || st.Size != 5 {
		t.Fatalf("stat = %#v", st)
	}
	link, err := d.StreamURL(context.Background(), "12345.mp4")
	if err != nil {
		t.Fatalf("StreamURL: %v", err)
	}
	if filepath.Clean(link.URL) != filepath.Clean(videoPath) {
		t.Fatalf("stream URL = %q, want %q", link.URL, videoPath)
	}
}

func TestBuildVideoID(t *testing.T) {
	if got := BuildVideoID("drive-a", "12345"); got != "spiderxvideos-drive-a-12345" {
		t.Fatalf("BuildVideoID = %q", got)
	}
}

func TestSafeJoinRejectsEscapes(t *testing.T) {
	d := New(Config{ID: "xv", RootDir: t.TempDir()})
	if _, err := d.VideoPath("../escape.mp4"); err == nil {
		t.Fatal("VideoPath accepted path traversal")
	}
	if _, err := d.ThumbPath("nested/thumb.jpg"); err == nil {
		t.Fatal("ThumbPath accepted nested path")
	}
}
