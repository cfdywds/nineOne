import importlib.util
import io
import os
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stdout


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "91VideoSpider" / "spider_xvideos.py"


def load_spider_module():
    if not SCRIPT_PATH.exists():
        raise AssertionError(f"script missing: {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("spider_xvideos", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class XVideosSpiderParserTests(unittest.TestCase):
    class StrictAsciiStream:
        encoding = "ascii"

        def __init__(self):
            self.data = ""

        def write(self, value):
            value.encode("ascii")
            self.data += value

        def flush(self):
            pass

    def test_parse_list_page_extracts_cards_and_deduplicates(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True)
        html = """
        <html><body>
          <div class="thumb-block" id="video_12345">
            <div class="thumb">
              <a href="/video12345/sample_title">
                <img data-src="//cdn.example.com/thumbs/12345.jpg" alt="Sample Title">
              </a>
            </div>
            <p class="title"><a href="/video12345/sample_title" title="Sample Title">Sample Title</a></p>
          </div>
          <div class="thumb-block" id="video_12345">
            <p class="title"><a href="/video12345/sample_title">Duplicate</a></p>
          </div>
          <div class="thumb-block" id="video_67890">
            <a class="title" href="https://www.xvideos.com/video67890/other">Other &amp; Video</a>
            <img src="https://cdn.example.com/thumbs/67890.jpg">
          </div>
        </body></html>
        """

        videos = spider.parse_list_page(html)

        self.assertEqual([v["viewkey"] for v in videos], ["12345", "67890"])
        self.assertEqual(videos[0]["title"], "Sample Title")
        self.assertEqual(videos[0]["detail_url"], "https://www.xvideos.com/video12345/sample_title")
        self.assertEqual(videos[0]["thumb_url"], "https://cdn.example.com/thumbs/12345.jpg")
        self.assertEqual(videos[1]["title"], "Other & Video")

    def test_parse_list_page_accepts_current_xvideos_slug_ids(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True)
        html = """
        <html><body>
          <div class="thumb-block">
            <a href="/video.oodttef4ef3/48258121/0/sample_title" title="Sample Title">
              <img data-src="//cdn.example.com/thumbs/slug.jpg">
            </a>
          </div>
        </body></html>
        """

        videos = spider.parse_list_page(html)

        self.assertEqual(len(videos), 1)
        self.assertEqual(videos[0]["viewkey"], "oodttef4ef3")
        self.assertEqual(videos[0]["detail_url"], "https://www.xvideos.com/video.oodttef4ef3/48258121/0/sample_title")

    def test_parse_detail_page_prefers_high_quality_and_decodes_js_strings(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True, quality="best")
        html = r"""
        <html><head>
          <meta property="og:image" content="https://cdn.example.com/fallback.jpg">
        </head><body>
          <script>
            html5player.setVideoTitle('A Test \u0026 Title');
            html5player.setThumbUrl('https:\/\/cdn.example.com\/thumb.jpg');
            html5player.setVideoUrlLow('https:\/\/cdn.example.com\/low.mp4?token=low\u0026n=1');
            html5player.setVideoUrlHigh('https:\/\/cdn.example.com\/high.mp4?token=high\u0026n=2');
          </script>
        </body></html>
        """

        info = spider.parse_detail_page(html)

        self.assertEqual(info["title"], "A Test & Title")
        self.assertEqual(info["thumb_url"], "https://cdn.example.com/thumb.jpg")
        self.assertEqual(info["video_url"], "https://cdn.example.com/high.mp4?token=high&n=2")
        self.assertEqual(info["source_quality"], "high")
        self.assertEqual(info["sources"]["low"], "https://cdn.example.com/low.mp4?token=low&n=1")

    def test_build_list_url_uses_xvideos_zero_based_page_parameter(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(start_url="https://www.xvideos.com/?k=test", no_download=True)

        self.assertEqual(spider.build_list_url(1), "https://www.xvideos.com/?k=test")
        self.assertEqual(spider.build_list_url(2), "https://www.xvideos.com/?k=test&p=1")
        self.assertEqual(spider.build_list_url(5), "https://www.xvideos.com/?k=test&p=4")

    def test_explicit_unlimited_max_pages_is_preserved_for_target_new_mode(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(target_new=15, max_pages=None, no_download=True)

        self.assertIsNone(spider.max_pages)

    def test_keyword_builds_xvideos_search_url(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(keyword="cat videos", no_download=True)

        self.assertEqual(spider.build_list_url(1), "https://www.xvideos.com/?k=cat+videos")
        self.assertEqual(spider.build_list_url(2), "https://www.xvideos.com/?k=cat+videos&p=1")

    def test_parse_human_sizes_and_durations_and_filter_unknowns(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(
            no_download=True,
            min_size="500MB",
            max_size="2GB",
            min_duration="01:00",
            max_duration="10:00",
        )

        self.assertEqual(spider.parse_size_limit("1.5GB"), 1610612736)
        self.assertEqual(spider.parse_duration_limit("01:30"), 90)
        self.assertTrue(spider.video_matches_filters({"video_size": 1000000000, "duration_seconds": 300}))
        self.assertFalse(spider.video_matches_filters({"video_size": 1000000000}))
        self.assertFalse(spider.video_matches_filters({"duration_seconds": 300}))

    def test_duration_limits_accept_m_and_h_suffixes_from_admin_form(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True)

        self.assertEqual(spider.parse_duration_limit("5m"), 300)
        self.assertEqual(spider.parse_duration_limit("1.5h"), 5400)
        self.assertEqual(spider.parse_duration_limit("30s"), 30)

    def test_filtered_videos_do_not_pollute_seen_set_for_later_pages(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(
            no_download=True,
            min_duration="60",
            detail_workers=1,
        )

        video = {
            "title": "Short video",
            "detail_url": "https://www.xvideos.com/video.short/short",
            "thumb_url": "",
            "viewkey": "short",
            "video_id": "short",
        }
        spider._handle_detail_info(
            video,
            {
                "title": "Short video",
                "thumb_url": "",
                "sources": {"high": "https://cdn.example.com/short.mp4"},
                "source_quality": "high",
                "video_url": "https://cdn.example.com/short.mp4",
                "duration_seconds": 30,
            },
        )

        self.assertEqual(spider.skipped_videos, 1)
        self.assertEqual(spider.processed_videos, 0)
        self.assertNotIn("short", spider.skip_viewkeys)
        self.assertIn("short", spider.filtered_viewkeys)

    def test_best_quality_prefers_hls_only_when_merge_enabled(self):
        mod = load_spider_module()
        sources = {
            "high": "https://cdn.example.com/video_360p.mp4",
            "hls": "https://cdn.example.com/hls.m3u8",
        }

        mp4_spider = mod.XVideosSpider(no_download=True, quality="best", merge_hls=False)
        hls_spider = mod.XVideosSpider(no_download=True, quality="best", merge_hls=True)

        self.assertEqual(mp4_spider._choose_source(sources), ("high", sources["high"]))
        self.assertEqual(hls_spider._choose_source(sources), ("hls", sources["hls"]))

    def test_parse_detail_page_extracts_duration_seconds(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True)
        html = r"""
        <html><head>
          <meta property="og:video:duration" content="125">
        </head><body>
          <script>
            html5player.setVideoUrlHigh('https:\/\/cdn.example.com\/high.mp4');
          </script>
        </body></html>
        """

        info = spider.parse_detail_page(html)

        self.assertEqual(info["duration_seconds"], 125)

    def test_print_help_lists_filter_and_keyword_options(self):
        mod = load_spider_module()
        out = io.StringIO()

        with redirect_stdout(out):
            mod.print_help()

        help_text = out.getvalue()
        for flag in ("--keyword", "--min-size", "--max-size", "--min-duration", "--max-duration", "--merge-hls"):
            self.assertIn(flag, help_text)

    def test_proxy_can_be_supplied_from_environment_and_detail_workers_are_configurable(self):
        mod = load_spider_module()
        proxy_url = "http://phone-server.tailbf8fb3.ts.net:10080"
        old_value = os.environ.get("SPIDER_PROXY")
        os.environ["SPIDER_PROXY"] = proxy_url
        try:
            spider = mod.XVideosSpider(no_download=True, detail_workers=4)
        finally:
            if old_value is None:
                os.environ.pop("SPIDER_PROXY", None)
            else:
                os.environ["SPIDER_PROXY"] = old_value

        self.assertEqual(spider.detail_workers, 4)
        self.assertEqual(spider.session.proxies.get("http"), proxy_url)
        self.assertEqual(spider.session.proxies.get("https"), proxy_url)

    def test_process_video_list_with_workers_avoids_sequential_detail_sleep(self):
        mod = load_spider_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            spider = mod.XVideosSpider(
                output_file=os.path.join(tmpdir, "out.json"),
                no_download=True,
                detail_workers=2,
            )

            def fake_fetch_page(url, description="", referer="", session=None):
                video_id = url.rsplit("/", 1)[-1]
                return rf"""
                <html><body><script>
                  html5player.setVideoUrlHigh('https:\/\/cdn.example.com\/{video_id}.mp4');
                </script></body></html>
                """

            spider.fetch_page = fake_fetch_page
            spider.random_sleep = lambda *args: self.fail("worker detail mode should not sleep between every detail request")
            videos = [
                {
                    "title": f"Video {idx}",
                    "detail_url": f"https://www.xvideos.com/video.v{idx}/v{idx}",
                    "thumb_url": "",
                    "viewkey": f"v{idx}",
                    "video_id": f"v{idx}",
                }
                for idx in range(3)
            ]

            spider._process_video_list(videos, referer="https://www.xvideos.com/")

        self.assertEqual(spider.processed_videos, 3)
        self.assertEqual(spider.failed_videos, 0)
        self.assertEqual({v["viewkey"] for v in spider.results}, {"v0", "v1", "v2"})
        self.assertTrue(all(v["download_status"] == "metadata_only" for v in spider.results))

    def test_log_replaces_unencodable_characters_in_console_output(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True)
        stream = self.StrictAsciiStream()
        old_stdout = sys.stdout
        sys.stdout = stream
        try:
            spider.log("title with ã and emoji 🚀")
        finally:
            sys.stdout = old_stdout

        self.assertIn("title with", stream.data)

    def test_stream_output_emits_ascii_safe_json_when_stdout_cannot_encode_unicode(self):
        mod = load_spider_module()
        spider = mod.XVideosSpider(no_download=True, stream_output=True)
        stream = self.StrictAsciiStream()
        old_stdout = sys.stdout
        sys.stdout = stream
        try:
            spider.emit_stream_video({"title": "麻豆傳媒", "viewkey": "abc"})
        finally:
            sys.stdout = old_stdout

        self.assertIn('"viewkey": "abc"', stream.data)
        self.assertIn("\\u9ebb", stream.data)

    def test_fetch_page_retries_direct_when_configured_proxy_fails(self):
        mod = load_spider_module()

        class Response:
            status_code = 200
            encoding = "utf-8"
            content = b"<html>ok</html>"

            def raise_for_status(self):
                return None

        class ProxyThenDirectSession:
            def __init__(self):
                self.proxies = {"http": "http://proxy.invalid:10080", "https": "http://proxy.invalid:10080"}
                self.calls = 0

            def get(self, url, timeout=30, headers=None):
                self.calls += 1
                if self.proxies:
                    raise mod.requests.exceptions.ProxyError("proxy refused")
                return Response()

        spider = mod.XVideosSpider(no_download=True, proxy="http://proxy.invalid:10080")
        fake_session = ProxyThenDirectSession()

        html = spider.fetch_page("https://www.xvideos.com/", session=fake_session)

        self.assertEqual(html, "<html>ok</html>")
        self.assertEqual(fake_session.calls, 2)


if __name__ == "__main__":
    unittest.main()
