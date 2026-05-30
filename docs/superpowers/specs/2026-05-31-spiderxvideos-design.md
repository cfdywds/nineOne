# SpiderXVideos 后台接入设计

## 目标

把 `www.xvideos.com` 爬虫作为一个独立视频源接入后台，行为对齐现有 `spider91`：

- 后台可新增、编辑、删除 `XVideos 爬虫` drive。
- 后台可点“立即抓取”。
- 凌晨 `nightly` 流水线自动抓取。
- 抓到的视频源文件和封面先落本地。
- 入库后前台可播放、筛选、生成封面、teaser、指纹。
- 可复用现有 spider91 上传目标，把本地爬虫视频迁移到 115 / PikPak / OneDrive。

## 非目标

- 不重构现有 `spider91` 为通用 crawler 框架。
- 不把 XVideos 混进 `spider91` kind。
- 不实现 HLS/m3u8 分片合并；Python 脚本若只拿到 HLS，在 Go 侧标记失败并记录错误。
- 不新增复杂的可视化配置页，只沿用现有 Drives 管理表单。

## 方案

新增独立 drive kind：`spiderxvideos`。

这条路线复制 `spider91` 的成熟接入模式，但保持包名、标签、存储目录、播放路由和迁移命名独立，避免影响 91 现有逻辑。

## 后端架构

### Python 脚本

继续使用 `91VideoSpider/spider_xvideos.py`。

Go 侧调用时使用：

```bash
python spider_xvideos.py \
  --target-new <N> \
  --seen-file <seen.txt> \
  --output <crawl.json> \
  --no-download \
  --stream-output \
  --url <start_url> \
  --quality <quality>
```

Python 只负责列表页、详情页解析和输出 JSONL；Go 侧负责下载、入库、封面复制和后续任务。这与 `spider91` 的运行分工一致。

### 新 package

创建 `backend/internal/drives/spiderxvideos/`：

- `driver.go`
  - `Kind = "spiderxvideos"`
  - 本地目录结构：`<data>/spiderxvideos/<driveID>/videos` 和 `thumbs`
  - 实现 `drives.Drive`
  - `StreamURL` 返回本地视频路径

- `crawler.go`
  - 启动 Python 脚本，读取 JSONL。
  - 下载视频源文件和封面。
  - 复制封面到全局 `data/previews/thumbs/<videoID>.jpg`。
  - 入库 `catalog.Video`。
  - `Author = "xvideos"`，默认系统标签 `xvideos`。
  - `VideoID = "spiderxvideos-<driveID>-<sourceID>"`。
  - `FileID = "<sourceID>.<ext>"`。
  - 支持 credentials：
    - `start_url`
    - `target_new`
    - `quality`
    - `proxy`
    - `cookie`
    - `python_path`
    - `script_path`

- `ext_test.go` / `driver_test.go` / `crawler_test.go`
  - 对齐 spider91 的单测覆盖。

## main.go 接入

新增：

- `spiderxvideosCrawlers map[string]*spiderxvideos.Crawler`
- `spiderXVideosRootDir()` / `spiderXVideosDriveDir(driveID)`
- `defaultSpiderXVideosScriptPath()`
- `attachSpiderXVideosCrawler()`
- `listSpiderXVideosDriveIDs()`
- `runSpiderXVideosCrawl()`
- 通用判断：`isCrawlerDriveKind(kind)` 用于排除 scanLoop 和 stale cleanup。

`attachDrive` 新增 `case spiderxvideos.Kind`，并注册 preview/thumb/fingerprint worker。

`OnScanRequested` 对 `spider91` 和 `spiderxvideos` 都走对应 crawler，而不是普通 scan。

## Nightly 流水线

Phase 2 扩展为“crawler drive 抓取阶段”：

- 先跑所有 `spider91`。
- 再跑所有 `spiderxvideos`。
- 两类 crawler 全部结束后等待 teaser/thumb 队列 idle。

为降低改动风险，先保留 `nightly.Config` 里已有的 spider91 字段，再新增：

- `ListSpiderXVideosDrives func(ctx context.Context) []string`
- `RunSpiderXVideosCrawl func(ctx context.Context, driveID string)`

日志文案从 `spider91` 扩展为 crawler source，但不改变现有 spider91 行为。

## 播放路由和来源标签

新增路由：

```text
/p/spiderxvideos/{videoID}
```

实现方式对齐 `/p/spider91/{videoID}`：

- 从 catalog 拿 `video.file_id`
- 从 registry 获取 `spiderxvideos.Driver`
- `VideoPath(fileID)` 后 `http.ServeFile`

`videoSource(v)` 对 `spiderxvideos` 返回 `/p/spiderxvideos/<videoID>`。

`driveKindLabel("spiderxvideos") = "XVideos 爬虫"`。

## Admin UI

前端 `AdminDrive.kind` 和 `UpsertDriveInput.kind` 增加 `"spiderxvideos"`。

`DrivesPage.tsx`：

- `kindLabel.spiderxvideos = "XVideos 爬虫"`
- drive 类型下拉新增 `XVideos Spider`
- `StatusTag` 对 `spiderxvideos` 同 `spider91`：无凭证也可显示“已就绪”
- 详情页隐藏根目录 ID / 扫描起点 ID
- 详情页显示上次抓取时间
- 行动按钮显示“立即抓取”
- 表单字段：
  - `start_url`：默认 `https://www.xvideos.com/`
  - `target_new`：默认 `15`
  - `quality`：默认 `best`
  - `proxy`
  - `cookie`
  - `python_path`
  - `script_path`

上传目标下拉复用现有 `spider91UploadDriveId` setting。UI 文案改成“爬虫视频上传目标”，说明 spider91 和 spiderxvideos 共用该目标。

## 迁移到云盘

现有 `spider91migrate` 扩展为支持两个来源：

- 原有 `spider91-*` 视频保持不变。
- 新增 `spiderxvideos-*` 视频迁移。
- 命名函数识别 `spiderxvideos-<driveID>-<sourceID>`，上传文件名包含来源前缀，避免与 91 文件冲突。
- 设置项仍用 `spider91.upload_drive_id`，但前端文案改为通用爬虫上传目标；后续可单独改名，当前为兼容不迁移设置 key。

## 错误处理

- Python 脚本不存在：drive crawl 标记 `status=error`，`last_error` 写明脚本路径问题。
- 列表或详情抓取失败：Python 输出减少，Go 侧不入库失败项。
- 视频下载失败：单条失败计数增加，整轮继续。
- 封面下载失败：视频仍入库，`thumbnail_status=failed`，避免 thumb worker 无限重试爬虫视频。
- HLS/m3u8：当前不下载，单条失败并记录错误。
- 每轮结束都更新 `last_crawl_at`，行为对齐 spider91。

## 测试策略

- Python 解析测试已覆盖列表页、详情页 URL 解析和翻页规则。
- Go driver 测试覆盖 Init/List/Stat/StreamURL/safeJoin/BuildVideoID。
- Go crawler 测试用 fake Python 脚本 + httptest：
  - 首次抓取下载视频和封面。
  - 第二次抓取 seen 文件跳过已存在 ID。
  - 封面失败时视频仍入库但 thumb 状态 failed。
  - 视频 URL 后缀识别。
- main 测试覆盖：
  - `listSpiderXVideosDriveIDs`
  - `shouldScanDrive` 排除 `spiderxvideos`
  - `spider91IntCred` 的通用化或复用解析。
- nightly 测试覆盖 Phase 2 同时调用 spider91 与 spiderxvideos。
- 前端测试覆盖 drive kind、表单字段、状态显示。

## 验收标准

- 后台可创建 `XVideos Spider` drive。
- 点击“立即抓取”能启动 `spider_xvideos.py` 并下载视频入库。
- 首页/详情页能播放 `spiderxvideos` 本地视频。
- 凌晨任务能自动跑 `spiderxvideos`。
- 已有 `spider91` 流程和测试不回退。
- `go test ./...`、前端测试、Python 单测通过。
