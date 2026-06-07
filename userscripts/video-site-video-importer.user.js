// ==UserScript==
// @name         Video Site 快速导入下载器
// @namespace    https://github.com/nianzhibai/91
// @version      0.1.1
// @description  在 XVideos / Pornhub 页面解析高清视频直链，并导入当前 Video Site 项目。
// @match        https://www.xvideos.com/*
// @match        https://www.pornhub.com/*
// @match        https://cn.pornhub.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const DEFAULT_PROJECT_BASE = "http://127.0.0.1:9191";
  const PROJECT_BASE_KEY = "video-site-importer-project-base";
  const DOWNLOAD_QUEUE_KEY = "video-site-importer-download-queue-v1";
  const VIDEO_FILE_PATTERN = /\.(mp4|webm|mov|mkv|avi)(?:[?#].*)?$/i;
  const HLS_FILE_PATTERN = /\.m3u8(?:[?#].*)?$/i;
  const MAX_PASTED_VIDEO_URLS = 50;
  const RECOVERY_PROGRESS_TIMEOUT_MS = 8000;
  const DOWNLOAD_STATUS_LABELS = {
    pending: "待提交",
    parsing: "解析中",
    submitting: "提交中",
    queued: "已排队",
    downloading: "下载中",
    saving: "保存中",
    completed: "已完成",
    error: "失败",
  };
  const ACTIVE_DOWNLOAD_STATUSES = new Set(["parsing", "submitting", "queued", "downloading", "saving"]);
  const state = {
    busy: false,
    lastCandidates: [],
    queueLoaded: false,
    downloadQueue: [],
    activeSessionCount: 0,
    activeProgressSessions: new Set(),
  };

  function detectSourceSite(locationLike = window.location) {
    const hostname = String(locationLike.hostname || "").toLowerCase();
    if (hostname.includes("xvideos.com")) return "xvideos";
    if (hostname.includes("pornhub.com")) return "pornhub";
    return "";
  }

  function detectSourceSiteFromURL(value) {
    try {
      return detectSourceSite(new URL(value, window.location.href));
    } catch {
      return "";
    }
  }

  function detectPageType(locationLike = window.location) {
    const pathname = String(locationLike.pathname || "").toLowerCase();
    const sourceSite = detectSourceSite(locationLike);
    if (!sourceSite) return "";
    if (sourceSite === "xvideos") {
      if (/^\/video(?:\d+|\.[a-z0-9]+)/i.test(pathname)) return "detail";
      return "list";
    }
    if (sourceSite === "pornhub") {
      if (/view_video\.php/i.test(pathname)) return "detail";
      if (pathname.startsWith("/video")) return "list";
      return "list";
    }
    return "";
  }

  function collectVideoCandidates() {
    const sourceSite = detectSourceSite();
    const candidates = [];
    collectDOMVideoCandidates(candidates);
    collectMetaVideoCandidates(candidates);
    if (sourceSite === "xvideos") {
      collectXVideosCandidates(candidates, document.documentElement.innerHTML);
    }
    if (sourceSite === "pornhub") {
      collectPornhubCandidates(candidates, document.documentElement.innerHTML);
    }
    const deduped = dedupeCandidates(candidates);
    state.lastCandidates = deduped;
    return deduped;
  }

  function pickBestCandidate(candidates) {
    const playable = candidates.filter((candidate) => {
      const url = normalizeURL(candidate.url);
      if (!url) return false;
      candidate.url = url;
      return VIDEO_FILE_PATTERN.test(url);
    });
    const pool = playable.length ? playable : candidates;
    pool.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    return pool[0] || null;
  }

  function scoreCandidate(candidate) {
    const url = normalizeURL(candidate.url);
    const qualityHeight = heightFromQuality(candidate.quality);
    let score = qualityHeight * 100;
    if (/\.mp4(?:[?#].*)?$/i.test(url)) score += 1000;
    if (/\.webm(?:[?#].*)?$/i.test(url)) score += 800;
    if (HLS_FILE_PATTERN.test(url)) score -= 500;
    if (/high|hd|1080|720|2160|4k/i.test(String(candidate.quality || ""))) score += 120;
    if (/low|mobile|240|144/i.test(String(candidate.quality || ""))) score -= 120;
    if (url.startsWith("https://")) score += 10;
    return score;
  }

  function heightFromQuality(quality) {
    const value = String(quality || "").toLowerCase();
    if (value.includes("4k") || value.includes("2160")) return 2160;
    const match = value.match(/(\d{3,4})\s*p?/);
    if (match) return Number(match[1]);
    if (value.includes("high") || value.includes("hd")) return 720;
    if (value.includes("low") || value.includes("sd")) return 360;
    if (value.includes("hls")) return 540;
    return 0;
  }

  function collectDOMVideoCandidates(candidates) {
    document.querySelectorAll("video[src], video source[src], source[type^='video/'][src]").forEach((node) => {
      candidates.push({
        url: node.currentSrc || node.src || node.getAttribute("src") || "",
        quality: node.getAttribute("res") || node.getAttribute("size") || node.getAttribute("label") || "dom",
        source: "dom",
      });
    });
  }

  function collectMetaVideoCandidates(candidates) {
    [
      "meta[property='og:video']",
      "meta[property='og:video:url']",
      "meta[property='og:video:secure_url']",
      "meta[name='twitter:player:stream']",
    ].forEach((selector) => {
      const content = document.querySelector(selector)?.getAttribute("content") || "";
      if (content) candidates.push({ url: content, quality: "meta", source: selector });
    });
  }

  function collectXVideosCandidates(candidates, html) {
    const setters = [
      ["setVideoUrlHigh", "high"],
      ["setVideoUrlLow", "low"],
      ["setVideoUrlHD", "hd"],
      ["setVideoHLS", "hls"],
    ];
    for (const [setter, quality] of setters) {
      const pattern = new RegExp(`${setter}\\(['"]([^'"]+)['"]\\)`, "gi");
      let match;
      while ((match = pattern.exec(html))) {
        candidates.push({ url: decodeScriptURL(match[1]), quality, source: "xvideos:" + setter });
      }
    }
    const genericPattern = /html5player\.setVideoUrl([A-Za-z0-9_]*)\(['"]([^'"]+)['"]\)/gi;
    let genericMatch;
    while ((genericMatch = genericPattern.exec(html))) {
      candidates.push({
        url: decodeScriptURL(genericMatch[2]),
        quality: genericMatch[1] || "video",
        source: "xvideos:html5player",
      });
    }
  }

  function collectPornhubCandidates(candidates, html) {
    const objectPattern = /\{[^{}]*"quality"\s*:\s*"?([^",}]+)"?[^{}]*"videoUrl"\s*:\s*"([^"]+)"[^{}]*\}/gi;
    let objectMatch;
    while ((objectMatch = objectPattern.exec(html))) {
      candidates.push({
        url: decodeScriptURL(objectMatch[2]),
        quality: objectMatch[1],
        source: "pornhub:mediaDefinitions",
      });
    }
    const reversedPattern = /\{[^{}]*"videoUrl"\s*:\s*"([^"]+)"[^{}]*"quality"\s*:\s*"?([^",}]+)"?[^{}]*\}/gi;
    let reversedMatch;
    while ((reversedMatch = reversedPattern.exec(html))) {
      candidates.push({
        url: decodeScriptURL(reversedMatch[1]),
        quality: reversedMatch[2],
        source: "pornhub:mediaDefinitions",
      });
    }
  }

  function collectVideoCandidatesFromHTML(html, pageURL, sourceSite = detectSourceSiteFromURL(pageURL)) {
    const candidates = [];
    collectMetaVideoCandidatesFromHTML(candidates, html);
    if (sourceSite === "xvideos") {
      collectXVideosCandidates(candidates, html);
    }
    if (sourceSite === "pornhub") {
      collectPornhubCandidates(candidates, html);
    }
    return dedupeCandidates(candidates, pageURL);
  }

  function collectMetaVideoCandidatesFromHTML(candidates, html) {
    [
      "og:video",
      "og:video:url",
      "og:video:secure_url",
      "twitter:player:stream",
    ].forEach((name) => {
      const content = findHTMLMetaContent(html, [name]);
      if (content) candidates.push({ url: content, quality: "meta", source: "meta:" + name });
    });
  }

  function dedupeCandidates(candidates, baseURL = window.location.href) {
    const seen = new Set();
    const out = [];
    for (const candidate of candidates) {
      const url = normalizeURL(candidate.url, baseURL);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ ...candidate, url });
    }
    return out;
  }

  function normalizeURL(value, baseURL = window.location.href) {
    const decoded = decodeScriptURL(value);
    if (!decoded) return "";
    try {
      return new URL(decoded, baseURL).href;
    } catch {
      return "";
    }
  }

  function decodeScriptURL(value) {
    let out = String(value || "").trim();
    if (!out) return "";
    out = out.replace(/\\\//g, "/");
    out = out.replace(/\\u002F/gi, "/");
    out = out.replace(/&amp;/g, "&");
    try {
      out = decodeURIComponent(out);
    } catch {
      // Some sites already provide a decoded URL; keep it as-is.
    }
    return out;
  }

  function htmlAttributeValue(attributes, name) {
    const pattern = new RegExp(`${name}\\s*=\\s*(['"])(.*?)\\1`, "i");
    const match = pattern.exec(attributes);
    return match ? decodeHTMLText(match[2]) : "";
  }

  function decodeHTMLText(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function findHTMLMetaContent(html, names) {
    const wanted = new Set(names.map((name) => String(name).toLowerCase()));
    const metaPattern = /<meta\b([^>]*)>/gi;
    let match;
    while ((match = metaPattern.exec(String(html || "")))) {
      const attributes = match[1];
      const metaName = (htmlAttributeValue(attributes, "property") || htmlAttributeValue(attributes, "name")).toLowerCase();
      if (!wanted.has(metaName)) continue;
      const content = htmlAttributeValue(attributes, "content").trim();
      if (content) return content;
    }
    return "";
  }

  function pageTitleFromHTML(html, pageURL) {
    const meta = findHTMLMetaContent(html, ["og:title", "twitter:title"]);
    if (meta) return meta;
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
    if (titleMatch && titleMatch[1].trim()) return decodeHTMLText(titleMatch[1]).trim();
    return filenameTitleFromURL(pageURL) || "Imported video";
  }

  function thumbnailURLFromHTML(html, pageURL) {
    const value = findHTMLMetaContent(html, ["og:image", "twitter:image"]);
    return value ? normalizeURL(value, pageURL) : "";
  }

  function durationSecondsFromHTML(html) {
    const value = findHTMLMetaContent(html, ["video:duration", "og:video:duration"]);
    const fromMeta = Number(value || 0);
    return Number.isFinite(fromMeta) && fromMeta > 0 ? Math.round(fromMeta) : 0;
  }

  function filenameTitleFromURL(value) {
    try {
      const parsed = new URL(value, window.location.href);
      const lastPart = parsed.pathname.split("/").filter(Boolean).pop() || "";
      return decodeURIComponent(lastPart).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    } catch {
      return "";
    }
  }

  function collectPageMetadata(candidate) {
    const sourceSite = detectSourceSite();
    return {
      sourceSite,
      pageUrl: window.location.href,
      videoUrl: candidate.url,
      title: pageTitle(),
      thumbnailUrl: thumbnailUrl(),
      quality: String(candidate.quality || ""),
      durationSeconds: durationSeconds(),
      referer: window.location.href,
    };
  }

  function pageTitle() {
    const selectors = [
      "meta[property='og:title']",
      "meta[name='twitter:title']",
    ];
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content");
      if (value && value.trim()) return value.trim();
    }
    const heading = document.querySelector("h1, .video-title, .title-container span");
    if (heading?.textContent?.trim()) return heading.textContent.trim();
    return document.title.replace(/\s+-\s+(XVIDEOS|Pornhub).*$/i, "").trim() || "Imported video";
  }

  function thumbnailUrl() {
    for (const selector of ["meta[property='og:image']", "meta[name='twitter:image']"]) {
      const value = document.querySelector(selector)?.getAttribute("content");
      if (value && value.trim()) return new URL(value.trim(), window.location.href).href;
    }
    const poster = document.querySelector("video[poster]")?.getAttribute("poster");
    return poster ? new URL(poster, window.location.href).href : "";
  }

  function durationSeconds() {
    const meta = document.querySelector("meta[property='video:duration'], meta[property='og:video:duration']")?.getAttribute("content");
    const fromMeta = Number(meta || 0);
    if (Number.isFinite(fromMeta) && fromMeta > 0) return Math.round(fromMeta);
    const video = document.querySelector("video");
    if (video && Number.isFinite(video.duration) && video.duration > 0) return Math.round(video.duration);
    return 0;
  }

  function projectBase() {
    return String(GM_getValue(PROJECT_BASE_KEY, DEFAULT_PROJECT_BASE) || DEFAULT_PROJECT_BASE).replace(/\/+$/, "");
  }

  function setProjectBase() {
    const next = window.prompt("请输入当前 Video Site 项目地址", projectBase());
    if (!next) return;
    GM_setValue(PROJECT_BASE_KEY, next.trim().replace(/\/+$/, ""));
    setStatus("项目地址已保存: " + projectBase());
  }

  function importBestVideo() {
    if (state.busy) return;
    const sourceSite = detectSourceSite();
    if (!sourceSite) {
      setStatus("当前站点不支持导入");
      return;
    }
    const candidates = collectVideoCandidates();
    const best = pickBestCandidate(candidates);
    if (!best) {
      setStatus("未找到可导入的视频直链");
      return;
    }
    if (HLS_FILE_PATTERN.test(best.url)) {
      setStatus("只找到 HLS/m3u8，当前快速导入优先支持 mp4/webm/mov/mkv/avi 直链");
      return;
    }
    state.busy = true;
    setStatus(`开始导入 ${sourceSite} ${best.quality || ""}...`);
    const payload = collectPageMetadata(best);
    postJSON(projectBase() + "/api/import/remote", payload)
      .then((response) => {
        const href = response?.href || (response?.id ? "/video/" + response.id : "");
        if (response?.accepted) {
          setStatus(href ? `已提交后台下载：${projectBase()}${href}` : "已提交后台下载，请稍后到项目后台查看");
          return;
        }
        setStatus(href ? `导入成功：${projectBase()}${href}` : "导入成功");
      })
      .catch((error) => {
        setStatus("导入失败：" + error.message);
      })
      .finally(() => {
        state.busy = false;
      });
  }

  function parsePastedVideoURLs(value) {
    const seen = new Set();
    const urls = [];
    String(value || "")
      .split(/[\s,，;；]+/)
      .map((item) => item.trim().replace(/^["'`]+|["'`]+$/g, ""))
      .forEach((item) => {
        const url = normalizeURL(item);
        if (!url || seen.has(url)) return;
        seen.add(url);
        urls.push(url);
      });
    return urls;
  }

  function loadDownloadQueue() {
    if (state.queueLoaded) return state.downloadQueue;
    let raw = GM_getValue(DOWNLOAD_QUEUE_KEY, "[]");
    let parsed = [];
    if (Array.isArray(raw)) {
      parsed = raw;
    } else {
      try {
        parsed = JSON.parse(String(raw || "[]"));
      } catch {
        parsed = [];
      }
    }
    state.downloadQueue = (Array.isArray(parsed) ? parsed : [])
      .map(normalizeDownloadQueueItem)
      .filter(Boolean);
    state.queueLoaded = true;
    return state.downloadQueue;
  }

  function saveDownloadQueue(items) {
    state.downloadQueue = (Array.isArray(items) ? items : [])
      .map(normalizeDownloadQueueItem)
      .filter(Boolean);
    state.queueLoaded = true;
    GM_setValue(DOWNLOAD_QUEUE_KEY, JSON.stringify(state.downloadQueue));
    renderDownloadQueuePanel();
    return state.downloadQueue;
  }

  function normalizeDownloadQueueItem(item) {
    const url = normalizeURL(item?.url || "");
    if (!url) return null;
    const status = DOWNLOAD_STATUS_LABELS[item?.status] ? item.status : "pending";
    const progressIndex = Number(item?.progressIndex);
    return {
      id: String(item?.id || downloadQueueItemID(url)),
      url,
      title: String(item?.title || filenameTitleFromURL(url) || url),
      status,
      progress: clampPercent(Number(item?.progress || 0)),
      href: String(item?.href || ""),
      videoId: String(item?.videoId || ""),
      message: String(item?.message || ""),
      error: String(item?.error || ""),
      sessionId: String(item?.sessionId || ""),
      progressToken: String(item?.progressToken || ""),
      progressIndex: Number.isInteger(progressIndex) && progressIndex >= 0 ? progressIndex : -1,
      addedAt: Number(item?.addedAt || Date.now()),
      updatedAt: Number(item?.updatedAt || Date.now()),
    };
  }

  function downloadQueueItemID(url) {
    let hash = 0;
    const value = String(url || "");
    for (let index = 0; index < value.length; index++) {
      hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }
    return "q-" + Math.abs(hash).toString(36);
  }

  function addDownloadQueueURLs(urls) {
    const queue = loadDownloadQueue().slice();
    const seen = new Set(queue.map((item) => item.url));
    let added = 0;
    let skipped = 0;
    for (const rawURL of Array.isArray(urls) ? urls : []) {
      const url = normalizeURL(rawURL);
      if (!url || seen.has(url)) {
        skipped++;
        continue;
      }
      seen.add(url);
      added++;
      queue.push({
        id: downloadQueueItemID(url),
        url,
        title: filenameTitleFromURL(url) || url,
        status: "pending",
        progress: 0,
        href: "",
        videoId: "",
        message: "已暂存",
        error: "",
        addedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    saveDownloadQueue(queue);
    return { added, skipped, total: queue.length };
  }

  function updateDownloadQueueItem(itemID, patch) {
    const queue = loadDownloadQueue().slice();
    const index = queue.findIndex((item) => item.id === itemID);
    if (index < 0) return null;
    queue[index] = normalizeDownloadQueueItem({
      ...queue[index],
      ...patch,
      updatedAt: Date.now(),
    });
    saveDownloadQueue(queue);
    return queue[index];
  }

  function collectListPageVideoLinksFromHTML(html, pageURL) {
    const links = [];
    const seen = new Set();
    const anchorPattern = /<a\b([^>]*)>/gi;
    let match;
    while ((match = anchorPattern.exec(String(html || "")))) {
      const href = htmlAttributeValue(match[1], "href");
      const url = normalizeURL(href, pageURL);
      if (!isSupportedDetailPageURL(url) || seen.has(url)) continue;
      seen.add(url);
      links.push(url);
    }
    return links;
  }

  function collectCurrentPageVideoLinks() {
    const links = [];
    const seen = new Set();
    document.querySelectorAll("a[href]").forEach((node) => {
      const url = normalizeURL(node.getAttribute("href") || node.href || "");
      if (!isSupportedDetailPageURL(url) || seen.has(url)) return;
      seen.add(url);
      links.push(url);
    });
    return links;
  }

  function isSupportedDetailPageURL(value) {
    try {
      const parsed = new URL(value, window.location.href);
      const sourceSite = detectSourceSite(parsed);
      const pathname = parsed.pathname.toLowerCase();
      if (sourceSite === "xvideos") return /^\/video(?:\d+|\.[a-z0-9]+)/i.test(pathname);
      if (sourceSite === "pornhub") return /\/view_video\.php/i.test(pathname);
      return false;
    } catch {
      return false;
    }
  }

  function stagePastedVideoURLs() {
    const textarea = document.querySelector('[data-role="pasted-video-urls"]');
    const urls = parsePastedVideoURLs(textarea?.value || "");
    if (urls.length === 0) {
      setStatus("请先粘贴视频地址");
      return { added: 0, skipped: 0, total: loadDownloadQueue().length };
    }
    const result = addDownloadQueueURLs(urls);
    if (textarea) textarea.value = "";
    setStatus(`已暂存 ${result.added} 个，跳过重复 ${result.skipped} 个；列表共 ${result.total} 个`);
    return result;
  }

  function stageCurrentPageVideoLinks() {
    const urls = collectCurrentPageVideoLinks();
    if (urls.length === 0) {
      setStatus("当前页未找到可暂存的视频链接");
      return { added: 0, skipped: 0, total: loadDownloadQueue().length };
    }
    const result = addDownloadQueueURLs(urls);
    setStatus(`本页已暂存 ${result.added} 个，跳过重复 ${result.skipped} 个；列表共 ${result.total} 个`);
    return result;
  }

  function clearDownloadQueue() {
    saveDownloadQueue([]);
    setStatus("暂存列表已清空");
  }

  function isActiveDownloadStatus(status) {
    return ACTIVE_DOWNLOAD_STATUSES.has(status);
  }

  function isDirectVideoURL(value) {
    return VIDEO_FILE_PATTERN.test(normalizeURL(value));
  }

  function isCurrentPageURL(value) {
    const input = normalizeURL(value);
    const current = normalizeURL(window.location.href);
    return Boolean(input && current && input === current);
  }

  async function importPastedVideos() {
    stagePastedVideoURLs();
    const pendingItems = loadDownloadQueue().filter((item) => item.status === "pending");
    if (pendingItems.length === 0) {
      const activeItems = loadDownloadQueue().filter((item) => isActiveDownloadStatus(item.status));
      if (activeItems.length > 0) {
        const result = recoverActiveDownloadQueue();
        if (result.resumed === 0 && result.marked === 0) {
          setStatus(`没有新的待提交地址，当前 ${activeItems.length} 个任务仍在下载中`);
        }
        return;
      }
      setStatus("请先粘贴或暂存视频地址");
      return;
    }
    if (pendingItems.length > MAX_PASTED_VIDEO_URLS) {
      setStatus(`一次最多提交 ${MAX_PASTED_VIDEO_URLS} 个地址；当前待提交 ${pendingItems.length} 个，请分批点击下载`);
    }

    const itemsToSubmit = pendingItems.slice(0, MAX_PASTED_VIDEO_URLS);
    setStatus(`正在解析 ${itemsToSubmit.length} 个待提交地址...`);
    const videoRequests = [];
    const requestItemIDs = [];
    const errors = [];

    for (let index = 0; index < itemsToSubmit.length; index++) {
      const item = itemsToSubmit[index];
      try {
        updateDownloadQueueItem(item.id, { status: "parsing", progress: 0, message: "正在解析..." });
        setStatus(`正在解析 ${index + 1}/${itemsToSubmit.length}：${item.url}`);
        const request = await buildPastedVideoRequest(item.url);
        videoRequests.push(request);
        requestItemIDs.push(item.id);
        updateDownloadQueueItem(item.id, {
          title: request.title || item.title,
          status: "submitting",
          progress: 0,
          message: "等待提交...",
          error: "",
        });
      } catch (error) {
        errors.push(`${index + 1}. ${error.message}`);
        updateDownloadQueueItem(item.id, {
          status: "error",
          progress: 100,
          error: error.message,
          message: "解析失败",
        });
      }
    }

    try {
      if (videoRequests.length === 0) {
        throw new Error(errors.join("；") || "没有可下载的视频地址");
      }
      setStatus(errors.length ? `跳过 ${errors.length} 个地址，提交 ${videoRequests.length} 个下载...` : `提交 ${videoRequests.length} 个下载...`);
      const response = await postJSON(projectBase() + "/api/import/remote/batch", { videos: videoRequests });
      if (!response || !response.results || !response.sessionId || !response.progressToken) {
        throw new Error("Invalid response from server");
      }
      applyBatchResultsToQueue(response.results, requestItemIDs, response.sessionId, response.progressToken);
      setStatus(`已提交后台下载：${videoRequests.length} 个；下载进度：0%`);
      subscribeToProgress(response.sessionId, videoRequests.length, response.results, {
        itemIDs: requestItemIDs,
        progressToken: response.progressToken,
      });
    } catch (error) {
      for (const itemID of requestItemIDs) {
        updateDownloadQueueItem(itemID, {
          status: "error",
          progress: 100,
          error: error.message,
          message: "提交失败",
        });
      }
      setStatus("下载失败：" + error.message);
    }
  }

  function applyBatchResultsToQueue(results, itemIDs, sessionId = "", progressToken = "") {
    (Array.isArray(results) ? results : []).forEach((result) => {
      const index = Number(result?.index);
      const itemID = Number.isInteger(index) ? itemIDs[index] : "";
      if (!itemID) return;
      if (result?.status === "error") {
        updateDownloadQueueItem(itemID, {
          status: "error",
          progress: 100,
          error: result.error || "提交失败",
          message: "提交失败",
        });
        return;
      }
      updateDownloadQueueItem(itemID, {
        status: "queued",
        progress: 0,
        href: result?.href || "",
        videoId: result?.id || "",
        sessionId: String(sessionId || ""),
        progressToken: String(progressToken || ""),
        progressIndex: index,
        message: "已加入下载队列",
        error: "",
      });
    });
  }

  async function buildPastedVideoRequest(inputURL) {
    const pastedSourceSite = detectSourceSiteFromURL(inputURL);
    const currentSourceSite = detectSourceSite();
    const sourceSite = pastedSourceSite || currentSourceSite;
    if (!sourceSite) {
      throw new Error("当前站点不支持导入：" + inputURL);
    }

    if (isCurrentPageURL(inputURL) && detectPageType() === "detail") {
      const candidates = collectVideoCandidates();
      const best = pickBestCandidate(candidates);
      if (!best) {
        throw new Error("未找到可下载的视频直链：" + inputURL);
      }
      if (HLS_FILE_PATTERN.test(best.url)) {
        throw new Error("只找到 HLS/m3u8，暂不下载：" + inputURL);
      }
      return collectPageMetadata(best);
    }

    if (isDirectVideoURL(inputURL)) {
      const pageURL = normalizeURL(window.location.href) || inputURL;
      return {
        sourceSite,
        pageUrl: pageURL,
        videoUrl: inputURL,
        title: filenameTitleFromURL(inputURL) || "Imported video",
        thumbnailUrl: "",
        quality: "",
        durationSeconds: 0,
        referer: pageURL,
      };
    }

    if (!pastedSourceSite) {
      throw new Error("只支持本站视频详情页或视频直链：" + inputURL);
    }

    const html = await fetchText(inputURL);
    const candidates = collectVideoCandidatesFromHTML(html, inputURL, pastedSourceSite);
    const best = pickBestCandidate(candidates);
    if (!best) {
      throw new Error("未找到可下载的视频直链：" + inputURL);
    }
    if (HLS_FILE_PATTERN.test(best.url)) {
      throw new Error("只找到 HLS/m3u8，暂不下载：" + inputURL);
    }

    return {
      sourceSite: pastedSourceSite,
      pageUrl: inputURL,
      videoUrl: best.url,
      title: pageTitleFromHTML(html, inputURL),
      thumbnailUrl: thumbnailURLFromHTML(html, inputURL),
      quality: String(best.quality || ""),
      durationSeconds: durationSecondsFromHTML(html),
      referer: inputURL,
    };
  }

  function isSameOriginURL(value) {
    try {
      return new URL(value, window.location.href).origin === new URL(window.location.href).origin;
    } catch {
      return false;
    }
  }

  async function fetchText(url) {
    if (isSameOriginURL(url) && typeof window.fetch === "function") {
      try {
        const response = await window.fetch(url, { credentials: "include" });
        if (response.ok) return await response.text();
      } catch {
        // Fall back to GM_xmlhttpRequest below.
      }
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        anonymous: false,
        withCredentials: true,
        timeout: 30_000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText || "");
            return;
          }
          reject(new Error(`HTTP ${response.status}`));
        },
        onerror() {
          reject(new Error("网络错误：" + url));
        },
        ontimeout() {
          reject(new Error("请求超时：" + url));
        },
      });
    });
  }

  function setDownloadButtonDisabled(disabled) {
    const button = document.querySelector('[data-role="download-pasted"]');
    if (button) button.disabled = disabled;
  }

  function resumeActiveDownloadProgress() {
    const groups = activeDownloadSessionGroups();
    if (groups.length > 0) {
      setStatus(`正在恢复 ${groups.length} 个下载会话的进度订阅...`);
    }
    let resumed = 0;
    for (const group of groups) {
      if (
        subscribeToProgress(group.sessionId, group.totalCount, group.results, {
          itemIDs: group.itemIDs,
          progressToken: group.progressToken,
          recovering: true,
        })
      ) {
        resumed++;
      }
    }
    return resumed;
  }

  function recoverActiveDownloadQueue() {
    return {
      resumed: resumeActiveDownloadProgress(),
      marked: markUnresumableActiveDownloads(),
    };
  }

  function activeDownloadSessionGroups() {
    const groupsBySession = new Map();
    for (const item of loadDownloadQueue()) {
      if (!item.sessionId || !item.progressToken || item.progressIndex < 0) continue;
      let group = groupsBySession.get(item.sessionId);
      if (!group) {
        group = { sessionId: item.sessionId, progressToken: item.progressToken, totalCount: 0, itemIDs: [], results: [], hasActive: false };
        groupsBySession.set(item.sessionId, group);
      }
      if (isActiveDownloadStatus(item.status)) group.hasActive = true;
      group.totalCount = Math.max(group.totalCount, item.progressIndex + 1);
      group.itemIDs[item.progressIndex] = item.id;
      group.results.push({
        index: item.progressIndex,
        id: item.videoId,
        href: item.href,
        status: item.status,
        progress: item.progress,
        message: item.message,
        error: item.error,
      });
    }
    return [...groupsBySession.values()].filter((group) => group.hasActive);
  }

  function markUnresumableActiveDownloads() {
    let marked = 0;
    const queue = loadDownloadQueue().map((item) => {
      if (!isActiveDownloadStatus(item.status) || (item.sessionId && item.progressToken)) return item;
      marked++;
      return {
        ...item,
        status: "pending",
        progress: 0,
        href: "",
        videoId: "",
        sessionId: "",
        progressToken: "",
        progressIndex: -1,
        message: "旧下载任务缺少进度会话，已转回待提交",
        error: "",
        updatedAt: Date.now(),
      };
    });
    if (marked > 0) {
      saveDownloadQueue(queue);
      setStatus(`旧下载任务缺少进度会话，已将 ${marked} 个转回待提交，可重新提交下载`);
    }
    return marked;
  }

  function returnProgressSessionToPending(sessionId, itemIDs = []) {
    const ids = new Set((Array.isArray(itemIDs) ? itemIDs : []).filter(Boolean));
    if (ids.size === 0) return 0;
    let marked = 0;
    const queue = loadDownloadQueue().map((item) => {
      if (!ids.has(item.id) || !isActiveDownloadStatus(item.status)) return item;
      marked++;
      return {
        ...item,
        status: "pending",
        progress: 0,
        href: "",
        videoId: "",
        sessionId: "",
        progressToken: "",
        progressIndex: -1,
        message: "进度会话已失效，已转回待提交",
        error: "",
        updatedAt: Date.now(),
      };
    });
    if (marked > 0) {
      saveDownloadQueue(queue);
      setStatus(`进度会话已失效，已将 ${marked} 个任务转回待提交，可重新提交下载`);
    }
    return marked;
  }

  function subscribeToProgress(sessionId, totalCount, results = [], options = {}) {
    const sessionKey = String(sessionId || "");
    const progressToken = String(options.progressToken || "");
    if (!sessionKey || !progressToken) return false;
    if (state.activeProgressSessions.has(sessionKey)) return false;
    state.activeProgressSessions.add(sessionKey);
    const progressMap = initialProgressMap(results);
    const resultMap = progressResultMap(results);
    const itemIDs = Array.isArray(options.itemIDs) ? options.itemIDs : [];
    const recovering = Boolean(options.recovering);
    let recoveryTimer = null;
    let sawProgressEvent = false;
    let progressStream = null;
    state.activeSessionCount++;
    const initialCounts = progressCounts(progressMap);
    if (initialCounts.finished >= totalCount) {
      setFinalProgressStatus(progressMap, resultMap, initialCounts, itemIDs, sessionKey);
      return true;
    }

    progressStream = openProgressStream(
      progressStreamURL(sessionKey, progressToken),
      (data) => {
        sawProgressEvent = true;
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }
        const index = Number(data.index);
        if (Number.isInteger(index)) {
          progressMap.set(index, data);
        }
        const counts = progressCounts(progressMap);
        const overallPercent = aggregateProgressPercent(progressMap, totalCount);
        const itemPercent = eventProgressPercent(data);
        const itemMessage = progressEventMessage(data);
        const location = downloadLocationFor(data, resultMap);
        const itemPrefix = Number.isInteger(index) ? `；当前 ${index + 1}/${totalCount}` : "；当前";
        const locationText = location ? `；下载位置：${location}` : "";
        if (Number.isInteger(index) && itemIDs[index]) {
          updateDownloadQueueItem(itemIDs[index], {
            status: data.status || "downloading",
            progress: itemPercent,
            href: data.href || resultMap.get(index)?.href || "",
            videoId: data.videoId || resultMap.get(index)?.id || "",
            message: itemMessage,
            error: data.error || "",
          });
        }
        setStatus(`下载进度：${overallPercent}%（${counts.finished}/${totalCount}）${itemPrefix}：${itemPercent}% ${itemMessage}${locationText}；成功:${counts.completed} 失败:${counts.error}`);
        if (counts.finished >= totalCount) {
          setFinalProgressStatus(progressMap, resultMap, counts, itemIDs, sessionKey);
          return true;
        }
        return false;
      },
      () => {
        setStatus("进度订阅断开，请刷新查看结果");
        finishProgressSession(sessionKey);
      }
    );
    if (recovering && !sawProgressEvent) {
      recoveryTimer = setTimeout(() => {
        if (sawProgressEvent) return;
        if (progressStream && typeof progressStream.close === "function") {
          progressStream.close();
        }
        returnProgressSessionToPending(sessionKey, itemIDs);
        finishProgressSession(sessionKey);
      }, RECOVERY_PROGRESS_TIMEOUT_MS);
    }
    return true;
  }

  function progressStreamURL(sessionId, progressToken) {
    return `${projectBase()}/api/import/progress/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(progressToken)}`;
  }

  function openProgressStream(url, onProgressEvent, onDisconnect) {
    if (typeof EventSource === "function") {
      return openEventSourceProgressStream(url, onProgressEvent, onDisconnect);
    }
    return openGMProgressStream(url, onProgressEvent, onDisconnect);
  }

  function openGMProgressStream(url, onProgressEvent, onDisconnect) {
    let closed = false;
    let request = null;
    let shouldAbortAfterOpen = false;
    let processedLength = 0;
    let pendingText = "";

    const close = () => {
      closed = true;
      if (request && typeof request.abort === "function") {
        request.abort();
      } else {
        shouldAbortAfterOpen = true;
      }
    };

    const consumeResponseText = (responseText) => {
      if (closed || typeof responseText !== "string") return;
      if (responseText.length < processedLength) {
        processedLength = 0;
        pendingText = "";
      }
      const nextChunk = responseText.slice(processedLength);
      processedLength = responseText.length;
      if (!nextChunk) return;
      pendingText += nextChunk;
      pendingText = pendingText.replace(/\r\n/g, "\n");
      let splitAt;
      while ((splitAt = pendingText.indexOf("\n\n")) >= 0) {
        const rawEvent = pendingText.slice(0, splitAt);
        pendingText = pendingText.slice(splitAt + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        try {
          const shouldClose = onProgressEvent(JSON.parse(dataLines.join("\n")));
          if (shouldClose) {
            close();
            return;
          }
        } catch (err) {
          console.error("Parse progress event failed:", err);
        }
      }
    };

    request = GM_xmlhttpRequest({
      method: "GET",
      url,
      headers: { Accept: "text/event-stream" },
      anonymous: false,
      withCredentials: true,
      onprogress(response) {
        consumeResponseText(response.responseText || "");
      },
      onload(response) {
        consumeResponseText(response.responseText || "");
        if (!closed && (response.status < 200 || response.status >= 300)) {
          onDisconnect();
          closed = true;
        }
      },
      onerror() {
        if (!closed) {
          closed = true;
          onDisconnect();
        }
      },
      ontimeout() {
        if (!closed) {
          closed = true;
          onDisconnect();
        }
      },
    });
    if (shouldAbortAfterOpen && request && typeof request.abort === "function") {
      request.abort();
    }
    return { close };
  }

  function openEventSourceProgressStream(url, onProgressEvent, onDisconnect) {
    const eventSource = new EventSource(url, { withCredentials: true });
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (onProgressEvent(data)) {
          eventSource.close();
        }
      } catch (err) {
        console.error("Parse progress event failed:", err);
      }
    };
    eventSource.onerror = () => {
      eventSource.close();
      onDisconnect();
    };
    return eventSource;
  }

  function finishProgressSession(sessionId) {
    if (sessionId) state.activeProgressSessions.delete(sessionId);
    state.activeSessionCount = Math.max(0, state.activeSessionCount - 1);
  }

  function setFinalProgressStatus(progressMap, resultMap, counts, itemIDs = [], sessionId = "") {
    for (let index = 0; index < itemIDs.length; index++) {
      const data = progressMap.get(index);
      if (!data) continue;
      updateDownloadQueueItem(itemIDs[index], {
        status: data.status || "completed",
        progress: eventProgressPercent(data),
        href: data.href || resultMap.get(index)?.href || "",
        videoId: data.videoId || resultMap.get(index)?.id || "",
        message: progressEventMessage(data),
        error: data.error || "",
      });
    }
    const finalLocations = formatDownloadLocations(progressMap, resultMap);
    setStatus(`导入完成：100% - ${counts.completed} 成功，${counts.error} 失败${finalLocations ? `；下载位置：${finalLocations}` : ""}`);
    finishProgressSession(sessionId);
  }

  function progressResultMap(results) {
    const resultMap = new Map();
    (Array.isArray(results) ? results : []).forEach((result) => {
      const index = Number(result?.index);
      if (Number.isInteger(index)) {
        resultMap.set(index, result);
      }
    });
    return resultMap;
  }

  function initialProgressMap(results) {
    const progressMap = new Map();
    (Array.isArray(results) ? results : []).forEach((result) => {
      const index = Number(result?.index);
      if (!Number.isInteger(index)) return;
      if (result?.status === "error") {
        progressMap.set(index, {
          index,
          videoId: result.id || "",
          href: result.href || "",
          status: "error",
          progress: 100,
          error: result.error || "提交失败",
        });
      } else if (result?.status === "completed") {
        progressMap.set(index, {
          index,
          videoId: result.id || "",
          href: result.href || "",
          status: "completed",
          progress: 100,
          message: result.message || "导入成功",
        });
      }
    });
    return progressMap;
  }

  function progressCounts(progressMap) {
    const counts = { completed: 0, error: 0, finished: 0 };
    for (const data of progressMap.values()) {
      if (data?.status === "completed") counts.completed++;
      if (data?.status === "error") counts.error++;
    }
    counts.finished = counts.completed + counts.error;
    return counts;
  }

  function aggregateProgressPercent(progressMap, totalCount) {
    if (!totalCount) return 0;
    let totalProgress = 0;
    for (let index = 0; index < totalCount; index++) {
      totalProgress += eventProgressPercent(progressMap.get(index));
    }
    return Math.round(totalProgress / totalCount);
  }

  function eventProgressPercent(data) {
    const explicitProgress = Number(data?.progress);
    if (Number.isFinite(explicitProgress)) {
      return clampPercent(explicitProgress);
    }
    switch (data?.status) {
      case "completed":
      case "error":
        return 100;
      case "saving":
        return 80;
      case "downloading":
        return 10;
      default:
        return 0;
    }
  }

  function clampPercent(value) {
    if (value < 0) return 0;
    if (value > 100) return 100;
    return Math.round(value);
  }

  function progressEventMessage(data) {
    if (data?.error) return "失败：" + data.error;
    if (data?.message) return data.message;
    switch (data?.status) {
      case "queued":
        return "已加入下载队列";
      case "downloading":
        return "正在下载视频...";
      case "saving":
        return "正在保存到数据库...";
      case "completed":
        return "导入成功";
      case "error":
        return "下载失败";
      default:
        return "等待进度更新";
    }
  }

  function downloadLocationFor(data, resultMap) {
    const index = Number(data?.index);
    const result = Number.isInteger(index) ? resultMap.get(index) : null;
    const href = String(data?.href || result?.href || "").trim();
    if (href) return absoluteProjectURL(href);
    const videoID = String(data?.videoId || result?.id || "").trim();
    return videoID ? absoluteProjectURL("/video/" + encodeURIComponent(videoID)) : "";
  }

  function absoluteProjectURL(href) {
    try {
      return new URL(href, projectBase() + "/").href;
    } catch {
      return "";
    }
  }

  function formatDownloadLocations(progressMap, resultMap) {
    const indexes = new Set([...resultMap.keys(), ...progressMap.keys()]);
    const locations = [...indexes]
      .sort((a, b) => a - b)
      .map((index) => {
        const location = downloadLocationFor(progressMap.get(index) || { index }, resultMap);
        return location ? `${index + 1}.${location}` : "";
      })
      .filter(Boolean);
    if (locations.length <= 3) return locations.join("；");
    return locations.slice(0, 3).join("；") + `；等 ${locations.length} 个`;
  }

  function renderDownloadQueuePanel() {
    const summaryNode = document.querySelector("#video-site-importer-panel [data-role='queue-summary']");
    const listNode = document.querySelector("#video-site-importer-panel [data-role='download-list']");
    if (!summaryNode && !listNode) return;
    const queue = loadDownloadQueue();
    if (summaryNode) {
      const counts = downloadQueueCounts(queue);
      summaryNode.textContent = `暂存 ${queue.length} 个｜待提交 ${counts.pending}｜下载中 ${counts.active}｜完成 ${counts.completed}｜失败 ${counts.error}`;
    }
    if (listNode) {
      listNode.innerHTML = renderDownloadListHTML(queue);
    }
  }

  function downloadQueueCounts(queue) {
    const counts = { pending: 0, active: 0, completed: 0, error: 0 };
    for (const item of queue) {
      if (item.status === "pending") counts.pending++;
      if (isActiveDownloadStatus(item.status)) counts.active++;
      if (item.status === "completed") counts.completed++;
      if (item.status === "error") counts.error++;
    }
    return counts;
  }

  function renderDownloadListHTML(items) {
    const queue = Array.isArray(items) ? items : [];
    if (queue.length === 0) {
      return `<div class="vsi-empty">暂无暂存任务。可粘贴链接，或翻页后点“暂存本页”。</div>`;
    }
    return queue
      .map((item, index) => {
        const status = item.status || "pending";
        const label = DOWNLOAD_STATUS_LABELS[status] || status;
        const progress = clampPercent(Number(item.progress || 0));
        const title = escapeHTML(item.title || filenameTitleFromURL(item.url) || item.url || "Untitled");
        const url = escapeHTML(shortDisplayURL(item.url || ""));
        const detailURL = item.href ? absoluteProjectURL(item.href) : item.videoId ? absoluteProjectURL("/video/" + encodeURIComponent(item.videoId)) : "";
        const location = downloadLocationHTML(status, detailURL);
        const error = item.error ? `<div class="vsi-item-error">${escapeHTML(item.error)}</div>` : "";
        return `
          <div class="vsi-download-item" data-status="${escapeAttribute(status)}">
            <div class="vsi-item-head">
              <span class="vsi-item-index">${index + 1}</span>
              <span class="vsi-item-title">${title}</span>
              <span class="vsi-item-status">${escapeHTML(label)}</span>
            </div>
            <div class="vsi-progress"><span style="width:${progress}%"></span></div>
            <div class="vsi-item-meta">${progress}% · ${url}${location ? " · " + location : ""}</div>
            ${error}
          </div>
        `;
      })
      .join("");
  }

  function downloadLocationHTML(status, detailURL) {
    if (!detailURL) return "";
    if (status === "completed") {
      return `<a href="${escapeAttribute(detailURL)}" target="_blank" rel="noopener">下载位置</a>`;
    }
    if (isActiveDownloadStatus(status)) {
      return `<span class="vsi-location-pending">完成后可用</span>`;
    }
    return "";
  }

  function shortDisplayURL(value) {
    try {
      const parsed = new URL(value, window.location.href);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const tail = parts.slice(-2).join("/");
      return parsed.hostname + (tail ? "/" + tail : parsed.pathname);
    } catch {
      return String(value || "");
    }
  }

  function escapeHTML(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHTML(value).replace(/`/g, "&#96;");
  }

  function postJSON(url, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        anonymous: false,
        withCredentials: true,
        timeout: 30_000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            try {
              const data = JSON.parse(response.responseText || "{}");
              if (response.status === 202 || data.status === "accepted") {
                data.accepted = true;
              }
              resolve(data);
            } catch (error) {
              reject(error);
            }
            return;
          }
          const loginHint = response.status === 401 ? "请先在项目地址登录；" : "";
          reject(new Error(`${loginHint}HTTP ${response.status} ${response.responseText || ""}`.trim()));
        },
        onerror() {
          reject(new Error("网络错误，请检查项目地址 " + projectBase()));
        },
        ontimeout() {
          reject(new Error("请求超时，请稍后到项目后台查看是否已开始下载"));
        },
      });
    });
  }

  function installPanel() {
    if (document.getElementById("video-site-importer-panel")) return;
    const pageType = detectPageType();
    const isList = pageType === "list";
    const panel = document.createElement("div");
    panel.id = "video-site-importer-panel";
    if (isList) {
      panel.innerHTML = `
        <textarea data-role="pasted-video-urls" placeholder="粘贴视频地址，每行一个；可翻页后继续暂存"></textarea>
        <div class="vsi-actions">
          <button type="button" data-role="stage-pasted">暂存输入</button>
          <button type="button" data-role="stage-current-page">暂存本页</button>
          <button type="button" data-role="download-pasted">提交下载</button>
          <button type="button" data-role="clear-queue">清空</button>
        </div>
        <button type="button" data-role="settings" title="设置项目地址">⚙</button>
        <div data-role="queue-summary">暂存 0 个｜待提交 0｜下载中 0｜完成 0｜失败 0</div>
        <div data-role="download-list"></div>
        <div data-role="status">就绪，可粘贴链接或暂存当前分页</div>
      `;
    } else {
      panel.innerHTML = `
        <button type="button" data-role="import">导入到 Video Site</button>
        <button type="button" data-role="settings" title="设置项目地址">⚙</button>
        <div data-role="status">就绪</div>
      `;
    }
    const style = document.createElement("style");
    style.textContent = `
      #video-site-importer-panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        width: 240px;
        padding: 12px;
        border-radius: 14px;
        background: rgba(16, 16, 20, 0.92);
        color: #fff;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #video-site-importer-panel .vsi-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      #video-site-importer-panel button {
        border: 0;
        border-radius: 999px;
        padding: 8px 12px;
        margin: 4px 2px;
        color: #fff;
        background: #ff4d8d;
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
      }
      #video-site-importer-panel button[data-role="settings"] {
        float: right;
        width: 34px;
        padding: 8px;
        background: #343847;
      }
      #video-site-importer-panel button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      #video-site-importer-panel textarea {
        width: 100%;
        min-height: 86px;
        box-sizing: border-box;
        resize: vertical;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 8px;
        padding: 8px;
        color: #fff;
        background: rgba(255,255,255,.08);
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        outline: none;
      }
      #video-site-importer-panel textarea::placeholder {
        color: #b8bbc8;
      }
      #video-site-importer-panel [data-role="queue-summary"] {
        clear: both;
        margin-top: 8px;
        color: #f1f2f6;
        font-size: 11px;
        font-weight: 700;
      }
      #video-site-importer-panel [data-role="download-list"] {
        clear: both;
        max-height: 210px;
        overflow: auto;
        margin-top: 8px;
        padding-right: 2px;
      }
      #video-site-importer-panel .vsi-empty {
        color: #aeb3c4;
        font-size: 11px;
        padding: 8px;
        border: 1px dashed rgba(255,255,255,.16);
        border-radius: 10px;
      }
      #video-site-importer-panel .vsi-download-item {
        padding: 8px;
        margin-bottom: 6px;
        border-radius: 10px;
        background: rgba(255,255,255,.08);
      }
      #video-site-importer-panel .vsi-item-head {
        display: grid;
        grid-template-columns: 20px 1fr auto;
        gap: 6px;
        align-items: center;
      }
      #video-site-importer-panel .vsi-item-index {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        background: rgba(255,255,255,.14);
        color: #fff;
        font-size: 10px;
      }
      #video-site-importer-panel .vsi-item-title {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        color: #fff;
        font-size: 12px;
        font-weight: 700;
      }
      #video-site-importer-panel .vsi-item-status {
        color: #ffd6e5;
        font-size: 10px;
        white-space: nowrap;
      }
      #video-site-importer-panel .vsi-progress {
        height: 5px;
        margin: 7px 0 5px;
        border-radius: 999px;
        background: rgba(255,255,255,.14);
        overflow: hidden;
      }
      #video-site-importer-panel .vsi-progress span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #ff4d8d, #ffb86c);
      }
      #video-site-importer-panel .vsi-item-meta,
      #video-site-importer-panel .vsi-item-error {
        color: #c9ccda;
        font-size: 10px;
        word-break: break-all;
      }
      #video-site-importer-panel .vsi-item-error {
        color: #ff9e9e;
        margin-top: 4px;
      }
      #video-site-importer-panel .vsi-item-meta a {
        color: #ffb9d1;
        text-decoration: none;
      }
      #video-site-importer-panel [data-role="status"] {
        clear: both;
        margin-top: 8px;
        word-break: break-all;
        color: #d8d9e0;
        font-size: 11px;
      }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);
    if (isList) {
      panel.querySelector('[data-role="stage-pasted"]')?.addEventListener("click", stagePastedVideoURLs);
      panel.querySelector('[data-role="stage-current-page"]')?.addEventListener("click", stageCurrentPageVideoLinks);
      panel.querySelector('[data-role="download-pasted"]')?.addEventListener("click", importPastedVideos);
      panel.querySelector('[data-role="clear-queue"]')?.addEventListener("click", clearDownloadQueue);
      renderDownloadQueuePanel();
      recoverActiveDownloadQueue();
    } else {
      panel.querySelector('[data-role="import"]')?.addEventListener("click", importBestVideo);
    }
    panel.querySelector('[data-role="settings"]')?.addEventListener("click", setProjectBase);
  }

  function setStatus(message) {
    const node = document.querySelector("#video-site-importer-panel [data-role='status']");
    if (node) node.textContent = message;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installPanel, { once: true });
  } else {
    installPanel();
  }
})();
