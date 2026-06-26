package scriptcrawler

import (
	"context"
	"log"
	"os"
	"strings"

	"github.com/video-site/backend/internal/catalog"
	"github.com/video-site/backend/internal/mediaasset"
	"github.com/video-site/backend/internal/mediasim"
)

const (
	nearDuplicateTitleThreshold           = 0.90
	nearDuplicateSSIMThreshold            = 0.95
	nearDuplicateDurationToleranceSeconds = 2
	nearDuplicateCandidateLimit           = 200
)

type nearDuplicateMatch struct {
	video           *catalog.Video
	titleSimilarity float64
	thumbnailSSIM   float64
}

func (c *Crawler) findNearDuplicateVideo(ctx context.Context, source *catalog.Video, sourceThumbPath string) (*nearDuplicateMatch, error) {
	if c == nil || c.cfg.Catalog == nil || source == nil {
		return nil, nil
	}
	sourceThumbPath = strings.TrimSpace(sourceThumbPath)
	commonThumbDir := strings.TrimSpace(c.cfg.CommonThumbDir)
	if sourceThumbPath == "" || commonThumbDir == "" || strings.TrimSpace(source.Title) == "" || source.DurationSeconds <= 0 {
		return nil, nil
	}
	if _, err := os.Stat(sourceThumbPath); err != nil {
		return nil, nil
	}

	candidates, err := c.cfg.Catalog.ListNearDuplicateVideoCandidates(ctx, source, nearDuplicateDurationToleranceSeconds, nearDuplicateCandidateLimit)
	if err != nil {
		return nil, err
	}
	for _, candidate := range candidates {
		if candidate == nil || candidate.ID == source.ID {
			continue
		}
		titleScore := mediasim.TitleSimilarity(source.Title, candidate.Title)
		if titleScore < nearDuplicateTitleThreshold {
			continue
		}
		candidateThumbPath := mediaasset.ThumbnailPathInDir(commonThumbDir, candidate.ID)
		if _, err := os.Stat(candidateThumbPath); err != nil {
			continue
		}
		ssimScore, err := mediasim.ImageSSIM(sourceThumbPath, candidateThumbPath)
		if err != nil {
			log.Printf("[scriptcrawler] drive=%s source_id=%s candidate=%s thumbnail ssim failed: %v", c.cfg.Driver.ID(), source.ID, candidate.ID, err)
			continue
		}
		if ssimScore >= nearDuplicateSSIMThreshold {
			return &nearDuplicateMatch{
				video:           candidate,
				titleSimilarity: titleScore,
				thumbnailSSIM:   ssimScore,
			}, nil
		}
	}
	return nil, nil
}
