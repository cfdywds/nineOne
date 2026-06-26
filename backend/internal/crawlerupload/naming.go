package crawlerupload

import (
	"strings"
	"unicode"
)

// 期望的上传文件名格式：
//
//	<sanitized-title>-<sourceID-后8位>.<ext>
//
// 例如：
//
//	"超白大奶职业律师约炮第一季-672d2fa0.mp4"
//
// 设计目标：
//   - 文件名一眼能看出视频内容（用 catalog 里的 title）
//   - 后缀的 sourceID 8 字符保证同标题不会撞名
//   - 全部字符在常见文件系统、网盘 API、HTTP/Aliyun OSS Key 编码里都安全
//
// 字符清洗规则（sanitizeTitle）：
//   - 去除控制字符（< 0x20 或 0x7F）
//   - 替换 / \ : * ? " < > | 为空格
//   - 折叠连续空白为单个空格
//   - trim 首尾空白与点号
//   - 截断到最多 maxTitleRunes 个 unicode 字符（不是字节）
//   - 最终为空时回退到 "video"，避免无效文件名

const maxTitleRunes = 80

// sanitizeTitle 把一段任意文本转成可作为文件名一部分的字符串。
func sanitizeTitle(title string) string {
	var b strings.Builder
	b.Grow(len(title))
	prevSpace := false
	for _, r := range title {
		switch {
		case unicode.IsSpace(r):
			// 任何空白（含 \n \t 全角空格）→ 折叠成单个 ASCII 空格
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
		case r < 0x20 || r == 0x7F:
			// 非空白控制字符 → 丢弃
		case isFilenameForbidden(r):
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
		default:
			b.WriteRune(r)
			prevSpace = false
		}
	}
	out := strings.TrimFunc(b.String(), func(r rune) bool {
		return unicode.IsSpace(r) || r == '.'
	})
	out = truncateRunes(out, maxTitleRunes)
	if out == "" {
		out = "video"
	}
	return out
}

func isFilenameForbidden(r rune) bool {
	switch r {
	case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
		return true
	}
	return false
}

func truncateRunes(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		count++
		if count > maxRunes {
			return s[:i]
		}
	}
	return s
}

// extractSourceID 从 video.ID（"<kind>-<driveID>-<sourceID>"）里
// 取出最后一段 sourceID。
//
// driveID 中如果有 "-" 不影响（用 LastIndex）。爬虫脚本应提供不包含 "-"
// 的稳定 source_id；如果包含 "-"，这里会取最后一段作为文件名后缀。
func extractSourceID(videoID string) string {
	if i := strings.LastIndex(videoID, "-"); i >= 0 {
		return videoID[i+1:]
	}
	return videoID
}

// sourceIDSuffix 取 sourceID 的最后 N 个字符；不足 N 返回原字符串。
//
// 默认 N=8（足够稀疏避免标题撞名时的同名冲突）。
const sourceIDSuffixLen = 8

func sourceIDSuffix(sourceID string) string {
	r := []rune(sourceID)
	if len(r) <= sourceIDSuffixLen {
		return string(r)
	}
	return string(r[len(r)-sourceIDSuffixLen:])
}

// desiredUploadName 构造爬虫视频上传到目标网盘时的期望文件名。
//
//	desiredUploadName("超白大奶律师约炮", "476fa8bf4b47e672d2fa", "mp4")
//	  → "超白大奶律师约炮-72d2fa.mp4"  // 实际是 e672d2fa（取最后 8）
//
// ext 不带前导点；空时默认 mp4。
func desiredUploadName(title, sourceID, ext string) string {
	clean := sanitizeTitle(title)
	suffix := sourceIDSuffix(strings.TrimSpace(sourceID))
	ext = strings.TrimSpace(ext)
	ext = strings.TrimPrefix(ext, ".")
	if ext == "" {
		ext = "mp4"
	}
	if suffix == "" {
		// sourceID 缺失时退化成 "<title>.<ext>"
		return clean + "." + ext
	}
	return clean + "-" + suffix + "." + ext
}

func desiredMigratedName(title, videoID, ext string) string {
	name := desiredPikPakName(title, extractViewKey(videoID), ext)
	if strings.HasPrefix(videoID, "spiderxvideos-") {
		return "xvideos-" + name
	}
	return name
}

func isCrawlerVideoID(videoID string) bool {
	return strings.HasPrefix(videoID, "spider91-") || strings.HasPrefix(videoID, "spiderxvideos-")
}
