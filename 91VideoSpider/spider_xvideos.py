#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XVIDEOS 视频爬虫脚本
===================

参考 spider_91porn.py 的使用方式，抓取 www.xvideos.com 列表页中的视频：
  - 视频标题
  - 封面图直链
  - 视频源文件直链
  - 视频源文件下载到本地
  - 封面图下载到本地

依赖安装:
    pip install requests beautifulsoup4 lxml

常用方法:
    # 默认抓首页第 1 页，并下载到 ./xvideos_downloads
    python spider_xvideos.py

    # 抓搜索结果前 2 页
    python spider_xvideos.py --url "https://www.xvideos.com/?k=keyword" --max-pages 2

    # 只输出元数据，不下载文件
    python spider_xvideos.py --no-download --output /tmp/xvideos.json

    # 凑够 10 个新视频，跳过 seen.txt 里已有的视频 ID
    python spider_xvideos.py --target-new 10 --seen-file /tmp/seen.txt --download-dir /data/xvideos

输出格式:
    {
      "videos": [
        {
          "title": "视频标题",
          "thumb_url": "https://...",
          "video_url": "https://...mp4?...",
          "viewkey": "12345678",
          "video_id": "12345678",
          "detail_url": "https://www.xvideos.com/video12345678/...",
          "local_video_path": "/abs/path/12345678_title.mp4",
          "local_thumb_path": "/abs/path/thumbs/12345678_title.jpg",
          "download_status": "downloaded"
        }
      ]
    }

说明:
    1. XVIDEOS 的视频源 URL 可能带时效性参数，建议抓到后尽快下载。
    2. 默认下载 MP4 直链；若页面只暴露 HLS，会记录 URL，但不会用 ffmpeg 合并分片。
    3. --url 可以是首页、搜索页、分类页；翻页时会按 XVIDEOS 的 p=0/1/2 规则构造。
"""

import argparse
import html
import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from urllib.parse import quote_plus

try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover - exercised only on missing dependency
    BeautifulSoup = None


# ===================== 配置区域 =====================
BASE_SITE = "https://www.xvideos.com"
DEFAULT_START_URL = "https://www.xvideos.com/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

MIN_PAGE_DELAY = 2.0
MAX_PAGE_DELAY = 4.0
MIN_DETAIL_DELAY = 1.0
MAX_DETAIL_DELAY = 3.0
MAX_RETRIES = 3
RETRY_DELAY = 4.0
DEFAULT_DETAIL_WORKERS = 4
MAX_DETAIL_WORKERS = 8

OUTPUT_FILE = "xvideos_videos.json"
DOWNLOAD_DIR = "xvideos_downloads"
MAX_PAGES = 1
MAX_EMPTY_PAGES = 2
RESUME = True

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".flv", ".m3u8"}
THUMB_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
# ===================================================


def require_bs4():
    if BeautifulSoup is None:
        raise RuntimeError("缺少依赖库 beautifulsoup4，请运行: pip install beautifulsoup4 lxml")


def decode_js_string(raw: str) -> str:
    """解码 JS 字符串字面量内容，处理 \\/、\\u0026、HTML entity 等。"""
    if raw is None:
        return ""
    try:
        value = json.loads('"' + raw.replace('"', r"\"") + '"')
    except Exception:
        try:
            value = raw.encode("utf-8").decode("unicode_escape")
        except Exception:
            value = raw
        value = value.replace(r"\/", "/").replace(r"\'", "'").replace(r"\"", '"')
    return html.unescape(value).strip()


def normalize_url(raw: str, base: str = BASE_SITE) -> str:
    raw = html.unescape((raw or "").strip())
    if not raw or raw.startswith("data:"):
        return ""
    if raw.startswith("//"):
        return "https:" + raw
    return urljoin(base, raw)


def sanitize_filename(name: str, max_len: int = 80) -> str:
    name = html.unescape(name or "").strip()
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "_", name)
    name = re.sub(r"\s+", " ", name).strip(" ._")
    if not name:
        return "video"
    return name[:max_len].strip(" ._") or "video"


def detect_ext(raw_url: str, allowed: set, default: str) -> str:
    path = urlparse(raw_url or "").path
    _, ext = os.path.splitext(path)
    ext = ext.lower()
    return ext if ext in allowed else default


def clamp_positive_int(value, default: int, max_value: int = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    if parsed <= 0:
        parsed = 1
    if max_value is not None:
        parsed = min(parsed, int(max_value))
    return parsed


def default_proxy_from_env() -> str:
    for name in ("SPIDER_XVIDEOS_PROXY", "SPIDER_PROXY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def safe_print(message: str, file=None, flush: bool = False):
    target = file or sys.stdout
    try:
        print(message, file=target, flush=flush)
    except UnicodeEncodeError:
        encoding = getattr(target, "encoding", None) or "utf-8"
        try:
            safe_message = str(message).encode(encoding, errors="replace").decode(encoding, errors="replace")
        except LookupError:
            safe_message = str(message).encode("utf-8", errors="replace").decode("utf-8", errors="replace")
        print(safe_message, file=target, flush=flush)


def extract_video_id(raw_url: str) -> str:
    parsed = urlparse(raw_url or "")
    target = parsed.path or raw_url or ""
    match = re.search(r"(?:^|/)video(\d+)(?:[/#?_\-]|$)", target)
    if match:
        return match.group(1)
    match = re.search(r"(?:^|/)video[._-]([A-Za-z0-9][A-Za-z0-9_-]*)(?:[/#?]|$)", target)
    if match:
        return match.group(1)
    match = re.search(r"(?:^|[^\d])video[_-]?(\d+)(?:[^\d]|$)", raw_url or "")
    return match.group(1) if match else ""


class XVideosSpider:
    def __init__(
        self,
        output_file: str = None,
        download_dir: str = None,
        start_url: str = None,
        keyword: str = "",
        start_page: int = 1,
        max_pages: int = MAX_PAGES,
        resume: bool = None,
        max_empty_pages: int = None,
        quiet: bool = False,
        target_new: int = None,
        seen_viewkeys: list = None,
        stream_output: bool = False,
        no_download: bool = False,
        quality: str = "best",
        min_size: str = "",
        max_size: str = "",
        min_duration: str = "",
        max_duration: str = "",
        merge_hls: bool = False,
        overwrite: bool = False,
        cookie: str = "",
        proxy: str = "",
        detail_workers: int = None,
    ):
        self.output_file = output_file if output_file is not None else OUTPUT_FILE
        self.download_dir = download_dir if download_dir is not None else DOWNLOAD_DIR
        self.cookie_header = (cookie or os.environ.get("SPIDER_XVIDEOS_COOKIE", "") or os.environ.get("SPIDER_COOKIE", "")).strip()
        self.proxy = (proxy or default_proxy_from_env()).strip()
        self.detail_workers = clamp_positive_int(
            detail_workers if detail_workers is not None else os.environ.get("SPIDER_XVIDEOS_DETAIL_WORKERS", os.environ.get("SPIDER_DETAIL_WORKERS", DEFAULT_DETAIL_WORKERS)),
            DEFAULT_DETAIL_WORKERS,
            MAX_DETAIL_WORKERS,
        )
        self.session = self._make_session()

        self.keyword = (keyword or "").strip()
        self.start_url = start_url or ("" if self.keyword else DEFAULT_START_URL)
        self.start_page = max(1, int(start_page or 1))
        if max_pages is None:
            self.max_pages = None
        else:
            self.max_pages = int(max_pages)
            if self.max_pages <= 0:
                self.max_pages = None
        self.resume = RESUME if resume is None else bool(resume)
        self.max_empty_pages = (
            MAX_EMPTY_PAGES if max_empty_pages is None else int(max_empty_pages)
        )
        self.target_new = target_new if target_new and target_new > 0 else None
        self.quiet = bool(quiet)
        self.stream_output = bool(stream_output)
        self.no_download = bool(no_download)
        self.quality = (quality or "best").lower()
        self.min_size = self.parse_size_limit(min_size)
        self.max_size = self.parse_size_limit(max_size)
        self.min_duration = self.parse_duration_limit(min_duration)
        self.max_duration = self.parse_duration_limit(max_duration)
        self.merge_hls = bool(merge_hls)
        self.overwrite = bool(overwrite)

        self.results = []
        self.pages_crawled = 0
        self.processed_videos = 0
        self.downloaded_videos = 0
        self.skipped_videos = 0
        self.failed_videos = 0
        self.skip_viewkeys = set()
        self.filtered_viewkeys = set()

        if seen_viewkeys:
            for vk in seen_viewkeys:
                vk = (vk or "").strip()
                if vk:
                    self.skip_viewkeys.add(vk)

        if self.resume and os.path.exists(self.output_file):
            try:
                with open(self.output_file, "r", encoding="utf-8") as f:
                    existing_data = json.load(f)
                for video in existing_data.get("videos", []):
                    self.results.append(video)
                    for key in ("viewkey", "video_id"):
                        value = str(video.get(key) or "").strip()
                        if value:
                            self.skip_viewkeys.add(value)
                if self.results:
                    self.log(f"已加载 {len(self.results)} 条历史结果用于断点续爬")
            except Exception as e:
                self.log(f"警告: 读取历史输出失败，将重新开始: {e}")

    def _make_session(self):
        session = requests.Session()
        session.headers.update(HEADERS)
        if self.cookie_header:
            session.headers.update({"Cookie": self.cookie_header})
        if self.proxy:
            session.proxies.update({"http": self.proxy, "https": self.proxy})
        try:
            from requests.adapters import HTTPAdapter
            from urllib3.util.retry import Retry
            retry_strategy = Retry(
                total=MAX_RETRIES,
                connect=MAX_RETRIES,
                read=MAX_RETRIES,
                backoff_factor=0.6,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=frozenset(["GET", "HEAD"]),
                raise_on_status=False,
            )
            adapter = HTTPAdapter(
                max_retries=retry_strategy,
                pool_connections=max(10, self.detail_workers * 2),
                pool_maxsize=max(10, self.detail_workers * 2),
            )
            session.mount("https://", adapter)
            session.mount("http://", adapter)
        except Exception:
            pass
        return session

    def log(self, message: str):
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{timestamp}] {message}"
        if self.stream_output:
            safe_print(line, file=sys.stderr, flush=True)
        else:
            safe_print(line)

    def emit_stream_video(self, video: dict):
        if not self.stream_output:
            return
        try:
            print(json.dumps(video, ensure_ascii=False), flush=True)
        except UnicodeEncodeError:
            try:
                print(json.dumps(video, ensure_ascii=True), flush=True)
            except Exception as e:
                print(f"[stream] emit failed: {e}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[stream] emit failed: {e}", file=sys.stderr, flush=True)

    def random_sleep(self, min_sec: float, max_sec: float):
        delay = random.uniform(min_sec, max_sec)
        if not self.quiet:
            self.log(f"  随机延时 {delay:.2f} 秒...")
        time.sleep(delay)

    def build_list_url(self, page_num: int) -> str:
        """
        XVIDEOS 搜索/列表页使用零基 p 参数：第 1 页无 p 或 p=0，第 2 页 p=1。
        若 --url 中含 {page} / {page0}，优先按模板替换。
        """
        page_num = max(1, int(page_num or 1))
        if not self.start_url and self.keyword:
            start_url = f"{BASE_SITE}/?k={quote_plus(self.keyword)}"
            if page_num == 1:
                return start_url
            return f"{start_url}&p={page_num - 1}"
        if not self.start_url:
            self.start_url = DEFAULT_START_URL
        if "{page0}" in self.start_url:
            return self.start_url.replace("{page0}", str(page_num - 1))
        if "{page}" in self.start_url:
            return self.start_url.replace("{page}", str(page_num))
        if page_num == 1:
            return self.start_url

        parsed = urlparse(self.start_url)
        query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != "p"]
        query.append(("p", str(page_num - 1)))
        return urlunparse(parsed._replace(query=urlencode(query)))

    def fetch_page(self, url: str, description: str = "", referer: str = "", session=None) -> str:
        headers_extra = {}
        if referer:
            headers_extra["Referer"] = referer
        client = session or self.session

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                self.log(f"正在请求: {description or url} (尝试 {attempt}/{MAX_RETRIES})")
                response = client.get(url, timeout=30, headers=headers_extra)
                if response.status_code == 403:
                    self.log("警告: 收到 403 Forbidden，可能需要 cookie 或代理")
                    if attempt < MAX_RETRIES:
                        self.random_sleep(RETRY_DELAY, RETRY_DELAY + 3)
                        continue
                    return ""
                response.raise_for_status()
                encoding = response.encoding or "utf-8"
                return response.content.decode(encoding, errors="replace")
            except requests.exceptions.ProxyError as e:
                self.log(f"代理请求失败: {e}")
                proxies = getattr(client, "proxies", None)
                if proxies:
                    proxies.clear()
                    if client is self.session:
                        self.proxy = ""
                    self.log("代理不可用，切换为直连重试")
                    continue
                if attempt < MAX_RETRIES:
                    self.random_sleep(RETRY_DELAY, RETRY_DELAY + 3)
                else:
                    return ""
            except requests.exceptions.RequestException as e:
                self.log(f"请求失败: {e}")
                if attempt < MAX_RETRIES:
                    self.random_sleep(RETRY_DELAY, RETRY_DELAY + 3)
                else:
                    return ""
        return ""

    def parse_list_page(self, html_text: str) -> list:
        """解析列表页，返回 [{title, detail_url, thumb_url, viewkey, video_id}, ...]。"""
        require_bs4()
        soup = BeautifulSoup(html_text or "", "lxml")
        videos = []
        seen = set()

        cards = soup.select("div.thumb-block, div[id^='video_'], div[id^='video-']")
        if not cards:
            cards = [soup]

        for card in cards:
            link = self._find_video_link(card)
            if not link:
                continue
            href = link.get("href", "")
            video_id = extract_video_id(href)
            if not video_id:
                # 有些卡片把 ID 放在 div#video_123 里。
                card_id = card.get("id", "") if hasattr(card, "get") else ""
                match = re.search(r"video[_-](\d+)", card_id)
                video_id = match.group(1) if match else ""
            if not video_id or video_id in seen:
                continue
            seen.add(video_id)

            detail_url = normalize_url(href)
            title = self._extract_card_title(card, link)
            thumb_url = self._extract_card_thumb(card)

            videos.append({
                "title": title,
                "detail_url": detail_url,
                "thumb_url": thumb_url,
                "viewkey": video_id,
                "video_id": video_id,
                "source_site": "xvideos",
            })

        return videos

    def _find_video_link(self, card):
        selectors = [
            "p.title a[href]",
            "a.title[href]",
            "a[href*='/video']",
            "a[href*='xvideos.com/video']",
        ]
        for selector in selectors:
            for link in card.select(selector):
                href = link.get("href", "")
                if extract_video_id(href):
                    return link
        return None

    def _extract_card_title(self, card, link) -> str:
        for candidate in (
            link.get("title", ""),
            link.get_text(" ", strip=True),
        ):
            candidate = html.unescape((candidate or "").strip())
            if candidate:
                return candidate

        title_el = card.select_one("p.title a, a.title, .title")
        if title_el:
            candidate = title_el.get("title", "") or title_el.get_text(" ", strip=True)
            candidate = html.unescape((candidate or "").strip())
            if candidate:
                return candidate

        img = card.find("img")
        if img:
            candidate = html.unescape((img.get("alt", "") or "").strip())
            if candidate:
                return candidate

        return "Untitled"

    def _extract_card_thumb(self, card) -> str:
        img = card.find("img")
        if not img:
            return ""
        for attr in ("data-src", "data-original", "data-lazy-src", "src"):
            value = img.get(attr, "")
            if value and not value.startswith("data:"):
                return normalize_url(value)
        srcset = img.get("srcset", "")
        if srcset:
            first = srcset.split(",", 1)[0].strip().split(" ", 1)[0]
            return normalize_url(first)
        return ""

    def parse_detail_page(self, html_text: str) -> dict:
        """
        解析详情页，返回:
            {"title", "thumb_url", "video_url", "source_quality", "sources"}
        """
        require_bs4()
        result = {"sources": {}}
        html_text = html_text or ""
        soup = BeautifulSoup(html_text, "lxml")

        title = (
            self._extract_js_call(html_text, "setVideoTitle")
            or self._meta_content(soup, "og:title")
            or self._meta_content(soup, "twitter:title")
            or self._document_title(soup)
        )
        if title:
            result["title"] = self._clean_detail_title(title)

        thumb_url = (
            self._extract_js_call(html_text, "setThumbUrl169")
            or self._extract_js_call(html_text, "setThumbUrl")
            or self._extract_js_call(html_text, "setThumbUrlBig")
            or self._meta_content(soup, "og:image")
            or self._meta_content(soup, "twitter:image")
        )
        if thumb_url:
            result["thumb_url"] = normalize_url(thumb_url)

        method_map = [
            ("hd", "setVideoUrlHD"),
            ("high", "setVideoUrlHigh"),
            ("low", "setVideoUrlLow"),
            ("hls", "setVideoHLS"),
        ]
        for quality, method in method_map:
            value = self._extract_js_call(html_text, method)
            if value:
                result["sources"][quality] = normalize_url(value)

        content_url = self._extract_content_url(soup, html_text)
        if content_url and "content" not in result["sources"]:
            result["sources"]["content"] = normalize_url(content_url)

        duration = self._extract_duration_seconds(soup, html_text)
        if duration is not None:
            result["duration_seconds"] = duration

        quality, video_url = self._choose_source(result["sources"])
        if video_url:
            result["source_quality"] = quality
            result["video_url"] = video_url
        return result

    def _extract_js_call(self, html_text: str, method: str) -> str:
        prefix = r"(?:html5player\.)?" + re.escape(method)
        patterns = [
            re.compile(prefix + r"\(\s*'((?:\\.|[^'\\])*)'\s*\)", re.S),
            re.compile(prefix + r'\(\s*"((?:\\.|[^"\\])*)"\s*\)', re.S),
        ]
        for pattern in patterns:
            match = pattern.search(html_text or "")
            if match:
                return decode_js_string(match.group(1))
        return ""

    def _meta_content(self, soup, key: str) -> str:
        meta = soup.find("meta", attrs={"property": key}) or soup.find("meta", attrs={"name": key})
        if meta:
            return html.unescape((meta.get("content", "") or "").strip())
        return ""

    def _document_title(self, soup) -> str:
        title_el = soup.find("title")
        return title_el.get_text(" ", strip=True) if title_el else ""

    def _clean_detail_title(self, title: str) -> str:
        title = html.unescape((title or "").strip())
        title = re.sub(r"\s*-\s*XVIDEOS\.COM\s*$", "", title, flags=re.IGNORECASE)
        title = re.sub(r"\s+", " ", title).strip()
        return title[:200]

    def _extract_content_url(self, soup, html_text: str) -> str:
        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            text = script.string or script.get_text() or ""
            try:
                data = json.loads(text)
            except Exception:
                continue
            if isinstance(data, dict):
                value = data.get("contentUrl") or data.get("embedUrl")
                if value:
                    return value

        match = re.search(r'["\']contentUrl["\']\s*:\s*["\']([^"\']+)["\']', html_text or "")
        if match:
            return decode_js_string(match.group(1))
        meta_video = self._meta_content(soup, "og:video")
        return meta_video

    def _extract_duration_seconds(self, soup, html_text: str):
        for key in ("og:video:duration", "video:duration", "duration"):
            value = self._meta_content(soup, key)
            if value:
                parsed = self._duration_value_to_seconds(value)
                if parsed is not None:
                    return parsed

        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            text = script.string or script.get_text() or ""
            try:
                data = json.loads(text)
            except Exception:
                continue
            if isinstance(data, dict):
                value = data.get("duration")
                parsed = self._duration_value_to_seconds(value)
                if parsed is not None:
                    return parsed

        match = re.search(r'["\']duration["\']\s*:\s*["\']?([0-9:.]+)', html_text or "", re.I)
        if match:
            return self._duration_value_to_seconds(match.group(1))
        return None

    def _duration_value_to_seconds(self, value):
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        match = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", text, re.I)
        if match:
            hours = int(match.group(1) or 0)
            minutes = int(match.group(2) or 0)
            seconds = int(match.group(3) or 0)
            return hours * 3600 + minutes * 60 + seconds
        try:
            return self.parse_duration_limit(text)
        except Exception:
            return None

    def _choose_source(self, sources: dict) -> tuple:
        orders = {
            "best": ["hls", "hd", "high", "low", "content"] if self.merge_hls else ["hd", "high", "low", "content", "hls"],
            "hd": ["hd", "high", "low", "content", "hls"],
            "high": ["high", "hd", "low", "content", "hls"],
            "low": ["low", "high", "hd", "content", "hls"],
            "hls": ["hls", "hd", "high", "low", "content"] if self.merge_hls else ["hd", "high", "low", "content", "hls"],
        }
        for quality in orders.get(self.quality, orders["best"]):
            value = sources.get(quality)
            if value:
                return quality, value
        return "", ""

    def parse_size_limit(self, value):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return int(value)
        text = str(value).strip().lower()
        if not text:
            return None
        match = re.match(r"^(\d+(?:\.\d+)?)([kmgt]?b?)?$", text)
        if not match:
            return int(float(text))
        num = float(match.group(1))
        unit = (match.group(2) or "b").lower()
        scale = {
            "b": 1,
            "kb": 1024,
            "mb": 1024 ** 2,
            "gb": 1024 ** 3,
            "tb": 1024 ** 4,
        }.get(unit, 1)
        return int(num * scale)

    def parse_duration_limit(self, value):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return int(value)
        text = str(value).strip().lower()
        if not text:
            return None
        match = re.match(r"^(\d+(?:\.\d+)?)([smhd])$", text)
        if match:
            num = float(match.group(1))
            scale = {
                "s": 1,
                "m": 60,
                "h": 3600,
                "d": 86400,
            }[match.group(2)]
            return int(num * scale)
        if ":" not in text:
            return int(float(text))
        parts = [int(p) for p in text.split(":")]
        if len(parts) == 2:
            mm, ss = parts
            return mm * 60 + ss
        if len(parts) == 3:
            hh, mm, ss = parts
            return hh * 3600 + mm * 60 + ss
        raise ValueError(f"invalid duration limit: {value}")

    def video_matches_filters(self, video: dict) -> bool:
        size = video.get("video_size")
        duration = video.get("duration_seconds")
        if size is None:
            size = video.get("size_bytes")
        if duration is None:
            duration = video.get("duration")
        if self.min_size is not None or self.max_size is not None:
            if size is None:
                return False
            size = int(size)
            if self.min_size is not None and size < self.min_size:
                return False
            if self.max_size is not None and size > self.max_size:
                return False
        if self.min_duration is not None or self.max_duration is not None:
            if duration is None:
                return False
            duration = int(duration)
            if self.min_duration is not None and duration < self.min_duration:
                return False
            if self.max_duration is not None and duration > self.max_duration:
                return False
        return True

    def crawl(self):
        self.log("=" * 60)
        self.log("XVIDEOS 视频爬虫启动")
        self.log("=" * 60)
        self.log(f"配置: 起始 URL {self.start_url}")
        if self.keyword:
            self.log(f"配置: 关键词 {self.keyword}")
        self.log(f"配置: 起始页 {self.start_page}, 最大爬取页数 {self.max_pages if self.max_pages else '不限'}")
        self.log(f"配置: 质量 {self.quality}, HLS 合并 {'开启' if self.merge_hls else '关闭'}, 下载 {'关闭' if self.no_download else '开启'}")
        filter_desc = []
        if self.min_size is not None:
            filter_desc.append(f"最小大小 {self.min_size}")
        if self.max_size is not None:
            filter_desc.append(f"最大大小 {self.max_size}")
        if self.min_duration is not None:
            filter_desc.append(f"最小时长 {self.min_duration}s")
        if self.max_duration is not None:
            filter_desc.append(f"最大时长 {self.max_duration}s")
        if filter_desc:
            self.log("配置: 过滤 " + ", ".join(filter_desc))
        self.log(f"配置: 输出文件 {os.path.abspath(self.output_file)}")
        if not self.no_download:
            self.log(f"配置: 下载目录 {os.path.abspath(self.download_dir)}")
        if self.target_new:
            self.log(f"配置: 目标新增视频数 {self.target_new}")
        if self.skip_viewkeys:
            self.log(f"配置: 已跳过 {len(self.skip_viewkeys)} 个已知视频 ID")
        self.log("")

        page_num = self.start_page
        consecutive_empty = 0
        crawled_in_session = 0

        while True:
            if self.max_pages is not None and crawled_in_session >= self.max_pages:
                self.log(f"达到配置的页数上限 {self.max_pages}，停止")
                break
            if consecutive_empty >= self.max_empty_pages:
                self.log(f"连续 {self.max_empty_pages} 页无结果，已达到末尾")
                break
            if self.target_new is not None and self.processed_videos >= self.target_new:
                self.log(f"已累计 {self.processed_videos} 个新视频，达到目标 {self.target_new}，停止")
                break

            page_url = self.build_list_url(page_num)
            if crawled_in_session > 0:
                self.log("")
                self.random_sleep(MIN_PAGE_DELAY, MAX_PAGE_DELAY)

            self.log(f"[页 {page_num}] 请求: {page_url}")
            page_html = self.fetch_page(page_url, f"列表页 第{page_num}页")
            if not page_html:
                self.log(f"[页 {page_num}] 获取失败，跳过")
                consecutive_empty += 1
                page_num += 1
                crawled_in_session += 1
                continue

            page_videos = self.parse_list_page(page_html)
            if not page_videos:
                self.log(f"[页 {page_num}] 页面无视频，可能已到末尾")
                consecutive_empty += 1
                page_num += 1
                crawled_in_session += 1
                continue

            consecutive_empty = 0
            known_on_page = sum(1 for v in page_videos if v["viewkey"] in self.skip_viewkeys)
            filtered_on_page = sum(
                1
                for v in page_videos
                if v["viewkey"] not in self.skip_viewkeys and v["viewkey"] in self.filtered_viewkeys
            )
            new_videos = [
                v
                for v in page_videos
                if v["viewkey"] not in self.skip_viewkeys and v["viewkey"] not in self.filtered_viewkeys
            ]
            if known_on_page > 0 or filtered_on_page > 0:
                parts = []
                if known_on_page > 0:
                    parts.append(f"{known_on_page} 个已处理")
                if filtered_on_page > 0:
                    parts.append(f"{filtered_on_page} 个本轮过滤")
                self.log(f"[页 {page_num}] 发现 {len(page_videos)} 个链接，其中 {', '.join(parts)}，{len(new_videos)} 个新视频")
            else:
                self.log(f"[页 {page_num}] 发现 {len(new_videos)} 个视频")

            if new_videos:
                self._process_video_list(new_videos, referer=page_url)
            self.pages_crawled += 1
            page_num += 1
            crawled_in_session += 1

        self._save_results()
        self._print_summary()

    def _process_video_list(self, videos: list, referer: str = ""):
        if self.detail_workers > 1 and len(videos) > 1:
            self._process_video_list_with_workers(videos, referer=referer)
            return

        for idx, video in enumerate(videos, 1):
            if self.target_new is not None and self.processed_videos >= self.target_new:
                return
            if video["viewkey"] in self.skip_viewkeys:
                self.log(f"  [SKIP] 已处理过: {video['viewkey']}")
                self.skipped_videos += 1
                continue
            if video["viewkey"] in self.filtered_viewkeys:
                self.log(f"  [SKIP] 本轮已过滤: {video['viewkey']}")
                continue

            self.log(f"  处理视频 {idx}/{len(videos)}: {video['title'][:60]}...")
            if idx > 1:
                self.random_sleep(MIN_DETAIL_DELAY, MAX_DETAIL_DELAY)

            detail_html = self.fetch_page(video["detail_url"], f"详情页 video_id={video['viewkey']}", referer=referer)
            if not detail_html:
                self._record_failure(video, "detail_fetch_failed")
                continue

            detail_info = self.parse_detail_page(detail_html)
            if detail_info.get("title"):
                video["title"] = detail_info["title"]
            if detail_info.get("thumb_url"):
                video["thumb_url"] = detail_info["thumb_url"]
            if detail_info.get("sources"):
                video["sources"] = detail_info["sources"]
            if detail_info.get("source_quality"):
                video["source_quality"] = detail_info["source_quality"]
            if detail_info.get("duration_seconds") is not None:
                video["duration_seconds"] = detail_info["duration_seconds"]

            video_url = detail_info.get("video_url", "")
            if not video_url:
                self._record_failure(video, "video_url_not_found")
                continue
            video["video_url"] = video_url

            if self.min_size is not None or self.max_size is not None:
                size = self.probe_content_length(video_url, referer=video["detail_url"])
                if size is not None:
                    video["video_size"] = size

            if not self.video_matches_filters(video):
                self.skipped_videos += 1
                self.filtered_viewkeys.add(video["viewkey"])
                self.log(f"  [SKIP] 不满足过滤条件: {video['viewkey']}")
                continue

            if self.no_download:
                video["download_status"] = "metadata_only"
                self.results.append(video)
                self.skip_viewkeys.add(video["viewkey"])
                self.processed_videos += 1
                self.log("  [OK] 成功提取视频直链")
                self.emit_stream_video(video)
                self._save_results()
                continue

            try:
                self._download_assets(video)
            except Exception as e:
                video["download_status"] = "failed"
                video["error"] = str(e)
                self.results.append(video)
                self.skip_viewkeys.add(video["viewkey"])
                self.failed_videos += 1
                self.log(f"  [FAIL] 下载失败: {e}")
                self._save_results()
                continue

            if not self.video_matches_filters(video):
                self.skipped_videos += 1
                self.filtered_viewkeys.add(video["viewkey"])
                self.log(f"  [SKIP] 下载后不满足过滤条件: {video['viewkey']}")
                self._save_results()
                continue

            self.results.append(video)
            self.skip_viewkeys.add(video["viewkey"])
            self.processed_videos += 1
            self.downloaded_videos += 1
            self.log("  [OK] 成功下载视频源文件")
            self.emit_stream_video(video)
            self._save_results()

    def _process_video_list_with_workers(self, videos: list, referer: str = ""):
        eligible = []
        for idx, video in enumerate(videos, 1):
            if self.target_new is not None and self.processed_videos >= self.target_new:
                return
            if video["viewkey"] in self.skip_viewkeys:
                self.log(f"  [SKIP] 已处理过: {video['viewkey']}")
                self.skipped_videos += 1
                continue
            if video["viewkey"] in self.filtered_viewkeys:
                self.log(f"  [SKIP] 本轮已过滤: {video['viewkey']}")
                continue
            self.log(f"  处理视频 {idx}/{len(videos)}: {video['title'][:60]}...")
            eligible.append((idx, video))

        cursor = 0
        while cursor < len(eligible):
            if self.target_new is not None and self.processed_videos >= self.target_new:
                return
            if self.target_new is not None:
                remaining = self.target_new - self.processed_videos
                if remaining <= 0:
                    return
                batch_size = min(self.detail_workers, remaining, len(eligible) - cursor)
            else:
                batch_size = min(self.detail_workers, len(eligible) - cursor)
            batch = eligible[cursor:cursor + batch_size]
            cursor += batch_size
            if not batch:
                break
            with ThreadPoolExecutor(max_workers=len(batch)) as executor:
                futures = {
                    executor.submit(self._fetch_detail_info, video, referer): (idx, video)
                    for idx, video in batch
                }
                for future in as_completed(futures):
                    if self.target_new is not None and self.processed_videos >= self.target_new:
                        return
                    idx, video = futures[future]
                    try:
                        detail_info, failure = future.result()
                    except Exception as e:
                        detail_info, failure = {}, f"detail_worker_error:{e}"
                    self._handle_detail_info(video, detail_info, failure)

    def _fetch_detail_info(self, video: dict, referer: str = ""):
        session = self._make_session()
        detail_html = self.fetch_page(
            video["detail_url"],
            f"详情页 video_id={video['viewkey']}",
            referer=referer,
            session=session,
        )
        if not detail_html:
            return {}, "detail_fetch_failed"
        return self.parse_detail_page(detail_html), ""

    def _handle_detail_info(self, video: dict, detail_info: dict, failure: str = ""):
        if failure:
            self._record_failure(video, failure)
            return

        if detail_info.get("title"):
            video["title"] = detail_info["title"]
        if detail_info.get("thumb_url"):
            video["thumb_url"] = detail_info["thumb_url"]
        if detail_info.get("sources"):
            video["sources"] = detail_info["sources"]
        if detail_info.get("source_quality"):
            video["source_quality"] = detail_info["source_quality"]
        if detail_info.get("duration_seconds") is not None:
            video["duration_seconds"] = detail_info["duration_seconds"]

        video_url = detail_info.get("video_url", "")
        if not video_url:
            self._record_failure(video, "video_url_not_found")
            return
        video["video_url"] = video_url

        if self.min_size is not None or self.max_size is not None:
            size = self.probe_content_length(video_url, referer=video["detail_url"])
            if size is not None:
                video["video_size"] = size

        if not self.video_matches_filters(video):
            self.skipped_videos += 1
            self.filtered_viewkeys.add(video["viewkey"])
            self.log(f"  [SKIP] 不满足过滤条件: {video['viewkey']}")
            return

        if self.no_download:
            video["download_status"] = "metadata_only"
            self.results.append(video)
            self.skip_viewkeys.add(video["viewkey"])
            self.processed_videos += 1
            self.log("  [OK] 成功提取视频直链")
            self.emit_stream_video(video)
            self._save_results()
            return

        try:
            self._download_assets(video)
        except Exception as e:
            video["download_status"] = "failed"
            video["error"] = str(e)
            self.results.append(video)
            self.skip_viewkeys.add(video["viewkey"])
            self.failed_videos += 1
            self.log(f"  [FAIL] 下载失败: {e}")
            self._save_results()
            return

        if not self.video_matches_filters(video):
            self.skipped_videos += 1
            self.filtered_viewkeys.add(video["viewkey"])
            self.log(f"  [SKIP] 下载后不满足过滤条件: {video['viewkey']}")
            self._save_results()
            return

        self.results.append(video)
        self.skip_viewkeys.add(video["viewkey"])
        self.processed_videos += 1
        self.downloaded_videos += 1
        self.log("  [OK] 成功下载视频源文件")
        self.emit_stream_video(video)
        self._save_results()

    def _record_failure(self, video: dict, reason: str):
        video["video_url"] = video.get("video_url", "")
        video["download_status"] = "failed"
        video["error"] = reason
        self.results.append(video)
        self.skip_viewkeys.add(video["viewkey"])
        self.failed_videos += 1
        self.log(f"  [FAIL] {reason}: {video['viewkey']}")
        self._save_results()

    def _download_assets(self, video: dict):
        video_id = str(video.get("viewkey") or video.get("video_id") or "").strip()
        if not video_id:
            raise ValueError("empty video_id")
        title_part = sanitize_filename(video.get("title", "video"))
        base_name = f"{video_id}_{title_part}"
        video_ext = detect_ext(video.get("video_url", ""), VIDEO_EXTS, ".mp4")
        if video_ext == ".m3u8" and not self.merge_hls:
            raise ValueError("只拿到 HLS/m3u8 地址，当前脚本不合并分片，请改用 --no-download 记录元数据")
        if video_ext == ".m3u8":
            raise ValueError("HLS/m3u8 合并由后端 ffmpeg 下载链路处理，Python 单独下载不支持")

        video_dir = os.path.abspath(self.download_dir)
        thumb_dir = os.path.join(video_dir, "thumbs")
        video_path = os.path.join(video_dir, base_name + video_ext)
        thumb_ext = detect_ext(video.get("thumb_url", ""), THUMB_EXTS, ".jpg")
        thumb_path = os.path.join(thumb_dir, base_name + thumb_ext)

        size, existed = self.download_file(video["video_url"], video_path, referer=video["detail_url"])
        video["local_video_path"] = video_path
        video["video_size"] = size
        video["download_status"] = "exists" if existed else "downloaded"

        if video.get("thumb_url"):
            try:
                thumb_size, thumb_existed = self.download_file(video["thumb_url"], thumb_path, referer=video["detail_url"])
                video["local_thumb_path"] = thumb_path
                video["thumb_size"] = thumb_size
                video["thumb_status"] = "exists" if thumb_existed else "downloaded"
            except Exception as e:
                video["thumb_status"] = "failed"
                video["thumb_error"] = str(e)
                self.log(f"  [WARN] 封面下载失败: {e}")

    def download_file(self, src: str, dst: str, referer: str = "") -> tuple:
        if not src:
            raise ValueError("empty download url")
        if os.path.exists(dst) and os.path.getsize(dst) > 0 and not self.overwrite:
            return os.path.getsize(dst), True

        os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
        tmp_path = dst + ".part"
        headers = {
            "User-Agent": HEADERS["User-Agent"],
            "Accept": "*/*",
        }
        if referer:
            headers["Referer"] = referer

        with self.session.get(src, stream=True, timeout=(20, 180), headers=headers) as response:
            if response.status_code < 200 or response.status_code >= 300:
                raise RuntimeError(f"HTTP {response.status_code}: {src}")
            written = 0
            with open(tmp_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 512):
                    if not chunk:
                        continue
                    f.write(chunk)
                    written += len(chunk)

        if written <= 0:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise RuntimeError("empty body")
        os.replace(tmp_path, dst)
        return written, False

    def probe_content_length(self, src: str, referer: str = ""):
        if not src:
            return None
        if detect_ext(src, VIDEO_EXTS, ".mp4") == ".m3u8":
            return None
        headers = {
            "User-Agent": HEADERS["User-Agent"],
            "Accept": "*/*",
        }
        if referer:
            headers["Referer"] = referer
        try:
            response = self.session.head(src, timeout=20, headers=headers, allow_redirects=True)
            if response.status_code < 200 or response.status_code >= 400:
                return None
            value = response.headers.get("Content-Length")
            return int(value) if value else None
        except Exception:
            return None

    def _save_results(self):
        output_data = {
            "crawl_time": datetime.now().isoformat(),
            "source_url": self.start_url,
            "pages_crawled": self.pages_crawled,
            "total_videos": len(self.results),
            "successful": self.processed_videos,
            "downloaded": self.downloaded_videos,
            "skipped": self.skipped_videos,
            "failed": self.failed_videos,
            "download_enabled": not self.no_download,
            "videos": self.results,
        }
        try:
            out_path = self.output_file
            parent = os.path.dirname(os.path.abspath(out_path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            tmp_path = out_path + ".part"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(output_data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, out_path)
        except Exception as e:
            self.log(f"保存结果失败: {e}")

    def _print_summary(self):
        self.log("")
        self.log("=" * 60)
        self.log("爬取完成")
        self.log("=" * 60)
        self.log(f"爬取页数: {self.pages_crawled}")
        self.log(f"成功视频: {self.processed_videos}")
        self.log(f"下载视频: {self.downloaded_videos}")
        self.log(f"跳过视频: {self.skipped_videos}")
        self.log(f"失败视频: {self.failed_videos}")
        self.log(f"结果文件: {os.path.abspath(self.output_file)}")
        if not self.no_download:
            self.log(f"下载目录: {os.path.abspath(self.download_dir)}")


def read_seen_file(path: str) -> list:
    seen = []
    if not path:
        return seen
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                value = line.strip()
                if value:
                    seen.append(value)
    except FileNotFoundError:
        print(f"警告: seen 文件不存在: {path}")
    except Exception as e:
        print(f"警告: 读取 seen 文件失败: {e}")
    return seen


def print_help():
    print(r"""
================================================
    XVIDEOS 视频爬虫
================================================

依赖:
    pip install requests beautifulsoup4 lxml

示例:
    python spider_xvideos.py
    python spider_xvideos.py --keyword "keyword" --max-pages 2
    python spider_xvideos.py --keyword "keyword" --min-size 500MB --max-size 2GB --min-duration 01:00 --max-duration 10:00
    python spider_xvideos.py --target-new 10 --seen-file /tmp/seen.txt --download-dir /data/xvideos
    python spider_xvideos.py --no-download --output /tmp/xvideos.json

参数:
    --url URL                 起始列表 URL，默认 https://www.xvideos.com/
    --keyword TEXT            搜索关键词；url 为空时自动构造 xvideos 搜索页
    --page N                  起始页，按用户习惯从 1 开始
    --max-pages N             最多爬几页；0 表示不限；默认 1
    --target-new N            凑够 N 个成功视频后停止
    --seen-file FILE          每行一个已处理过的视频 ID，命中即跳过
    --seen-viewkeys-file FILE seen-file 的兼容别名
    --output FILE             输出 JSON 路径，默认 xvideos_videos.json
    --download-dir DIR        视频下载目录，默认 xvideos_downloads
    --no-download             只抓元数据和视频直链，不下载源文件
    --quality Q               best/hd/high/low/hls，默认 best
    --min-size SIZE           最小文件大小，如 500MB / 1.5GB
    --max-size SIZE           最大文件大小，如 2GB
    --min-duration DURATION   最小时长，支持秒数、mm:ss、hh:mm:ss
    --max-duration DURATION   最大时长，支持秒数、mm:ss、hh:mm:ss
    --merge-hls               best/hls 可选择 HLS；下载合并由后端 ffmpeg 处理
    --overwrite               本地文件已存在时重新下载
    --no-resume               不读取已有 output JSON 做断点续爬
    --cookie COOKIE           附加 Cookie 请求头
    --proxy URL               显式代理，如 http://127.0.0.1:7890
    --detail-workers N        并发抓详情页的 worker 数，默认 4，最大 8
    --stream-output           每处理一条就输出一行 JSON 到 stdout，日志走 stderr
    --quiet                   减少日志
    -h / --help               帮助
================================================
""")


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help", "help"):
        print_help()
        return

    parser = argparse.ArgumentParser(
        prog="spider_xvideos.py",
        description="XVIDEOS 视频源文件爬虫",
        add_help=False,
    )
    parser.add_argument("--url", type=str, default="")
    parser.add_argument("--keyword", type=str, default="")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--target-new", type=int, default=None)
    parser.add_argument("--seen-file", type=str, default=None)
    parser.add_argument("--seen-viewkeys-file", type=str, default=None)
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--download-dir", type=str, default=None)
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument("--quality", type=str, default="best", choices=["best", "hd", "high", "low", "hls"])
    parser.add_argument("--min-size", type=str, default="")
    parser.add_argument("--max-size", type=str, default="")
    parser.add_argument("--min-duration", type=str, default="")
    parser.add_argument("--max-duration", type=str, default="")
    parser.add_argument("--merge-hls", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--no-resume", action="store_true")
    parser.add_argument("--cookie", type=str, default="")
    parser.add_argument("--proxy", type=str, default="")
    parser.add_argument("--detail-workers", type=int, default=None)
    parser.add_argument("--stream-output", action="store_true")
    parser.add_argument("--quiet", action="store_true")

    args, _ = parser.parse_known_args()
    seen_path = args.seen_file or args.seen_viewkeys_file
    seen_viewkeys = read_seen_file(seen_path)

    if args.max_pages is None:
        # target-new 模式默认不限页，直到凑够或连续空页停止；普通手动模式默认只抓 1 页。
        max_pages = None if args.target_new is not None else MAX_PAGES
    else:
        max_pages = None if args.max_pages <= 0 else args.max_pages

    spider = XVideosSpider(
        output_file=args.output,
        download_dir=args.download_dir,
        start_url=args.url,
        keyword=args.keyword,
        start_page=args.page,
        max_pages=max_pages,
        resume=False if args.no_resume else None,
        quiet=args.quiet,
        target_new=args.target_new,
        seen_viewkeys=seen_viewkeys,
        stream_output=args.stream_output,
        no_download=args.no_download,
        quality=args.quality,
        min_size=args.min_size,
        max_size=args.max_size,
        min_duration=args.min_duration,
        max_duration=args.max_duration,
        merge_hls=args.merge_hls,
        overwrite=args.overwrite,
        cookie=args.cookie,
        proxy=args.proxy,
        detail_workers=args.detail_workers,
    )

    try:
        spider.crawl()
    except KeyboardInterrupt:
        spider.log("\n用户中断，正在保存已爬取的数据...")
        spider._save_results()
        spider._print_summary()
        sys.exit(0)
    except Exception as e:
        spider.log(f"发生未预料的错误: {e}")
        import traceback
        traceback.print_exc()
        spider._save_results()
        raise


if __name__ == "__main__":
    main()
