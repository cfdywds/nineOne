// Package spiderxvideos 把 XVideos 爬虫下载到本地的视频和封面包装成
// drives.Drive 实现，让它跟 spider91 一样作为视频源接入 catalog。
package spiderxvideos

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/video-site/backend/internal/drives"
)

const Kind = "spiderxvideos"

type Config struct {
	ID      string
	RootDir string
}

type Driver struct {
	id      string
	rootDir string
}

func New(c Config) *Driver {
	return &Driver{id: c.ID, rootDir: c.RootDir}
}

func (d *Driver) Kind() string   { return Kind }
func (d *Driver) ID() string     { return d.id }
func (d *Driver) RootID() string { return "/" }
func (d *Driver) RootDir() string {
	return d.rootDir
}

func (d *Driver) Init(ctx context.Context) error {
	if strings.TrimSpace(d.rootDir) == "" {
		return errors.New("spiderxvideos: empty rootDir")
	}
	for _, sub := range []string{"videos", "thumbs"} {
		if err := os.MkdirAll(filepath.Join(d.rootDir, sub), 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (d *Driver) VideosDir() string { return filepath.Join(d.rootDir, "videos") }
func (d *Driver) ThumbsDir() string { return filepath.Join(d.rootDir, "thumbs") }

func (d *Driver) VideoPath(fileID string) (string, error) {
	return safeJoin(d.VideosDir(), fileID)
}

func (d *Driver) ThumbPath(fileID string) (string, error) {
	return safeJoin(d.ThumbsDir(), fileID)
}

func (d *Driver) List(ctx context.Context, dirID string) ([]drives.Entry, error) {
	entries, err := os.ReadDir(d.VideosDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]drives.Entry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, drives.Entry{
			ID:      e.Name(),
			Name:    e.Name(),
			Size:    info.Size(),
			IsDir:   false,
			ModTime: info.ModTime(),
		})
	}
	return out, nil
}

func (d *Driver) Stat(ctx context.Context, fileID string) (*drives.Entry, error) {
	path, err := d.VideoPath(fileID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &drives.Entry{
		ID:      fileID,
		Name:    fileID,
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
	}, nil
}

func (d *Driver) StreamURL(ctx context.Context, fileID string) (*drives.StreamLink, error) {
	path, err := d.VideoPath(fileID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() || info.Size() == 0 {
		return nil, os.ErrNotExist
	}
	return &drives.StreamLink{URL: path, Expires: time.Now().Add(24 * time.Hour)}, nil
}

func (d *Driver) Upload(ctx context.Context, parentID, name string, r io.Reader, size int64) (string, error) {
	return "", drives.ErrNotSupported
}

func (d *Driver) EnsureDir(ctx context.Context, pathFromRoot string) (string, error) {
	return "", drives.ErrNotSupported
}

func safeJoin(root, fileID string) (string, error) {
	id := strings.TrimSpace(fileID)
	if id == "" || filepath.Base(id) != id {
		return "", errors.New("spiderxvideos: invalid file id")
	}
	if root == "" {
		return "", errors.New("spiderxvideos: empty root dir")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(filepath.Join(rootAbs, id))
	if err != nil {
		return "", err
	}
	if pathAbs != rootAbs && !strings.HasPrefix(pathAbs, rootAbs+string(os.PathSeparator)) {
		return "", errors.New("spiderxvideos: file id escapes root")
	}
	return pathAbs, nil
}

var _ drives.Drive = (*Driver)(nil)
