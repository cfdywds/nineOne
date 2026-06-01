package spiderxvideos

import "testing"

func TestDetectVideoExt(t *testing.T) {
	cases := map[string]string{
		"https://cdn.example/video/12345.mp4?token=1": ".mp4",
		"https://cdn.example/video/12345.webm":        ".webm",
		"https://cdn.example/video/12345.m3u8":        ".mp4",
		"https://cdn.example/video/12345":             ".mp4",
	}
	for raw, want := range cases {
		if got := detectVideoExt(raw); got != want {
			t.Fatalf("detectVideoExt(%q)=%q want %q", raw, got, want)
		}
	}
}

func TestDetectThumbExt(t *testing.T) {
	cases := map[string]string{
		"https://cdn.example/thumb/12345.jpg?x=1": ".jpg",
		"https://cdn.example/thumb/12345.webp":    ".webp",
		"https://cdn.example/thumb/12345":         ".jpg",
	}
	for raw, want := range cases {
		if got := detectThumbExt(raw); got != want {
			t.Fatalf("detectThumbExt(%q)=%q want %q", raw, got, want)
		}
	}
}

func TestSourceIDForItemAcceptsCurrentXVideosSlugIDs(t *testing.T) {
	item := spiderVideoEntry{
		VideoID: "oodttef4ef3",
		Viewkey: "oodttef4ef3",
	}

	if got := sourceIDForItem(item); got != "oodttef4ef3" {
		t.Fatalf("sourceIDForItem() = %q, want current XVideos slug id", got)
	}
}
