# 油猴视频快速导入脚本

脚本路径：

```text
userscripts/video-site-video-importer.user.js
```

## 功能

- 支持 `https://www.xvideos.com/*`、`https://www.pornhub.com/*` 和 `https://cn.pornhub.com/*` 页面。
- 自动区分来源站点，导入后会写入来源作者、来源标签和来源页面说明。
- 从页面脚本、`video/source` 节点和 OpenGraph 元数据中收集视频候选。
- 优先选择更高清的直链候选，例如 `1080p` 优先于 `720p`，`high/HD` 优先于 `low/SD`。
- 点击页面右下角“导入到 Video Site”后，请求当前项目的 `/api/import/remote`；后端先返回“已提交”，再在后台下载视频并写入本地上传盘，避免长视频下载时浏览器脚本请求超时。
- 在列表页可把视频详情页地址或视频直链粘贴到脚本面板，每行一个，点击“暂存输入”加入下载队列。
- 在列表分页中可点击“暂存本页”，把当前页视频详情链接加入队列；队列使用油猴存储，翻页后仍会保留，重复链接会自动跳过。
- 点击“提交下载”只提交当前“待提交”的任务；已有任务下载中时仍可继续粘贴/暂存并再次提交新增任务。
- 批量下载会以任务列表展示每条视频的状态、进度百分比、错误信息和对应的 Video Site 视频页位置。

## 安装

1. 安装 Tampermonkey / Violentmonkey。
2. 新建用户脚本，把 `userscripts/video-site-video-importer.user.js` 的内容复制进去保存。
3. 先在当前项目地址登录，例如本地默认：

   ```text
   http://127.0.0.1:9191
   ```

4. 打开 `www.xvideos.com`、`www.pornhub.com` 或 `cn.pornhub.com` 视频详情页，点击右下角“导入到 Video Site”。
5. 在列表页可把多个视频地址粘贴到右下角面板，每行一个，点击“暂存输入”后再点“提交下载”；也可以翻页后点“暂存本页”累积队列。

## 项目地址

脚本默认导入到：

```text
http://127.0.0.1:9191
```

如果你的项目部署在其它地址，点击脚本面板里的 `⚙`，把地址改成实际项目地址。

## 后端导入流程

脚本提交的 JSON 会包含：

- `sourceSite`：`xvideos` 或 `pornhub`
- `pageUrl`：来源页面
- `videoUrl`：选出的高清视频直链
- `title` / `thumbnailUrl` / `quality` / `durationSeconds`
- `referer`：用于后端下载时携带来源 Referer

后端接口：

```text
POST /api/import/remote
```

接口校验通过后会返回 `202 Accepted`，响应中包含预计的视频 `id` 和 `href`。随后后台任务会把视频下载到本项目的本地上传目录，写入 catalog，并触发封面 / 预览 / 指纹等现有生成队列。
