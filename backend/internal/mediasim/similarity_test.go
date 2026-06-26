package mediasim

import (
	"image"
	"image/color"
	"testing"
)

func TestTitleSimilarityNormalizesPunctuationAndWhitespace(t *testing.T) {
	score := TitleSimilarity("AB-123  测试视频.mp4", "ab123测试视频")
	if score < 0.90 {
		t.Fatalf("similarity = %.3f, want >= 0.90", score)
	}
}

func TestTitleSimilarityUsesLeadingCoreTitle(t *testing.T) {
	score := TitleSimilarity(
		"反差极品大二女友，叫声可射～，“射进小骚逼里面～” - 性感小皮鞭",
		"反差极品大二女友，叫声可射～，“射进小骚逼里面～”",
	)
	if score < 0.99 {
		t.Fatalf("similarity = %.3f, want core-title match", score)
	}
}

func TestTitleSimilarityDoesNotMatchBySharedSuffixOnly(t *testing.T) {
	score := TitleSimilarity(
		"高颜值大学生宿舍自拍视频完整流出 - 同一个来源",
		"户外旅行风景记录城市夜景合集 - 同一个来源",
	)
	if score >= 0.90 {
		t.Fatalf("similarity = %.3f, want < 0.90", score)
	}
}

func TestTitleSimilarityRejectsDifferentTitles(t *testing.T) {
	score := TitleSimilarity("完全不同的视频标题", "another unrelated movie")
	if score >= 0.90 {
		t.Fatalf("similarity = %.3f, want < 0.90", score)
	}
}

func TestSSIMScoresIdenticalAndDifferentImages(t *testing.T) {
	red := solidImage(color.RGBA{R: 220, G: 20, B: 20, A: 255})
	redAgain := solidImage(color.RGBA{R: 220, G: 20, B: 20, A: 255})
	blue := solidImage(color.RGBA{R: 20, G: 20, B: 220, A: 255})

	if score := SSIM(red, redAgain); score < 0.999 {
		t.Fatalf("identical SSIM = %.6f, want close to 1", score)
	}
	if score := SSIM(red, blue); score >= 0.95 {
		t.Fatalf("different SSIM = %.6f, want < 0.95", score)
	}
}

func solidImage(c color.RGBA) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}
