import importlib.util
import io
import pathlib
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


if __name__ == "__main__":
    unittest.main()
