package catalog

import (
	"context"
	"testing"
	"time"
)

func TestListVideosKeywordMatchesFileName(t *testing.T) {
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
		ID:          "p115-115-sone-089-4k",
		DriveID:     "drive",
		FileID:      "file-sone-089-4k",
		FileName:    "www.98T.la@sone-089-4k.mp4",
		Title:       "www.98T.la@sone-089",
		Author:      "4k",
		PublishedAt: now,
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("seed video: %v", err)
	}

	items, total, err := cat.ListVideos(ctx, ListParams{
		Keyword:  "www.98T.la@sone-089-4k.mp4",
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("list videos: %v", err)
	}
	if total != 1 {
		t.Fatalf("total = %d, want 1", total)
	}
	if len(items) != 1 || items[0].ID != "p115-115-sone-089-4k" {
		t.Fatalf("items = %#v, want seeded video", items)
	}
}
