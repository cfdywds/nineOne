package catalog

import (
	"context"
	"testing"
	"time"
)

func TestIncrementViewStoresLastViewedAt(t *testing.T) {
	ctx := context.Background()
	cat, err := Open(t.TempDir() + "/catalog.db")
	if err != nil {
		t.Fatalf("open catalog: %v", err)
	}
	t.Cleanup(func() {
		if err := cat.Close(); err != nil {
			t.Fatalf("close catalog: %v", err)
		}
	})

	now := time.Now()
	if err := cat.UpsertVideo(ctx, &Video{
		ID:          "video-1",
		DriveID:     "drive",
		FileID:      "file-1",
		Title:       "Video 1",
		PublishedAt: now,
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("seed video: %v", err)
	}

	if _, err := cat.IncrementView(ctx, "video-1"); err != nil {
		t.Fatalf("increment view: %v", err)
	}
	got, err := cat.GetVideo(ctx, "video-1")
	if err != nil {
		t.Fatalf("get video: %v", err)
	}
	if got.Views != 1 {
		t.Fatalf("views = %d, want 1", got.Views)
	}
	if got.LastViewedAt.IsZero() {
		t.Fatal("last viewed time was not stored")
	}
}

func TestListVideosRecentSortUsesLastViewedAt(t *testing.T) {
	ctx := context.Background()
	cat, err := Open(t.TempDir() + "/catalog.db")
	if err != nil {
		t.Fatalf("open catalog: %v", err)
	}
	t.Cleanup(func() {
		if err := cat.Close(); err != nil {
			t.Fatalf("close catalog: %v", err)
		}
	})

	now := time.Now()
	for _, v := range []*Video{
		{ID: "old-view", DriveID: "drive", FileID: "old-view", Title: "Old View", PublishedAt: now.Add(3 * time.Hour), CreatedAt: now, UpdatedAt: now},
		{ID: "recent-view", DriveID: "drive", FileID: "recent-view", Title: "Recent View", PublishedAt: now, CreatedAt: now, UpdatedAt: now},
		{ID: "unviewed", DriveID: "drive", FileID: "unviewed", Title: "Unviewed", PublishedAt: now.Add(4 * time.Hour), CreatedAt: now, UpdatedAt: now},
	} {
		if err := cat.UpsertVideo(ctx, v); err != nil {
			t.Fatalf("seed %s: %v", v.ID, err)
		}
	}
	if _, err := cat.db.ExecContext(ctx,
		`UPDATE videos SET last_viewed_at = CASE id
			WHEN 'old-view' THEN ?
			WHEN 'recent-view' THEN ?
			ELSE 0
		END`,
		now.Add(-time.Hour).UnixMilli(),
		now.Add(time.Hour).UnixMilli(),
	); err != nil {
		t.Fatalf("seed last_viewed_at: %v", err)
	}

	items, _, err := cat.ListVideos(ctx, ListParams{Sort: "recent", Page: 1, PageSize: 3})
	if err != nil {
		t.Fatalf("list recent videos: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	got := []string{items[0].ID, items[1].ID, items[2].ID}
	want := []string{"recent-view", "old-view", "unviewed"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("recent order = %#v, want %#v", got, want)
		}
	}
}
