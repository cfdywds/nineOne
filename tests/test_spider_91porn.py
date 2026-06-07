import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "91VideoSpider" / "spider_91porn.py"


def load_spider_module():
    if not SCRIPT_PATH.exists():
        raise AssertionError(f"script missing: {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("spider_91porn", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Porn91SpiderBehaviorTests(unittest.TestCase):
    class StrictAsciiStream:
        encoding = "ascii"

        def __init__(self):
            self.data = ""

        def write(self, value):
            value.encode("ascii")
            self.data += value

        def flush(self):
            pass

    def test_proxy_cookie_and_detail_workers_are_configurable(self):
        mod = load_spider_module()
        proxy_url = "http://phone-server.tailbf8fb3.ts.net:10080"

        spider = mod.Porn91Spider(
            output_file=os.devnull,
            resume=False,
            proxy=proxy_url,
            cookie="foo=bar",
            detail_workers=4,
        )

        self.assertEqual(spider.detail_workers, 4)
        self.assertEqual(spider.session.proxies.get("http"), proxy_url)
        self.assertEqual(spider.session.proxies.get("https"), proxy_url)
        self.assertEqual(spider.session.headers.get("Cookie"), "foo=bar")

    def test_process_video_list_with_workers_avoids_sequential_detail_sleep(self):
        mod = load_spider_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            spider = mod.Porn91Spider(
                output_file=os.path.join(tmpdir, "out.json"),
                resume=False,
                detail_workers=2,
            )

            def fake_fetch_page(url, description="", referer="", session=None, **kwargs):
                return "source_id=" + url.rsplit("/", 1)[-1]

            def fake_parse_detail_page(html):
                source_id = html.split("=", 1)[1]
                return {
                    "video_url": f"https://cdn.example.com/mp43/{source_id}.mp4",
                    "source_id": source_id,
                }

            spider.fetch_page = fake_fetch_page
            spider.parse_detail_page = fake_parse_detail_page
            spider.random_sleep = lambda *args: self.fail("worker detail mode should not sleep between every detail request")
            videos = [
                {
                    "title": f"Video {idx}",
                    "detail_url": f"https://www.91porn.com/{100 + idx}",
                    "thumb_url": "",
                    "viewkey": f"vk{idx}",
                    "source_id": str(100 + idx),
                }
                for idx in range(3)
            ]

            spider._process_video_list(videos, referer="https://www.91porn.com/v.php")

        self.assertEqual(spider.processed_videos, 3)
        self.assertEqual(spider.failed_videos, 0)
        self.assertEqual({v["viewkey"] for v in spider.results}, {"vk0", "vk1", "vk2"})

    def test_sequential_target_mode_uses_short_detail_delay(self):
        mod = load_spider_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            spider = mod.Porn91Spider(
                output_file=os.path.join(tmpdir, "out.json"),
                resume=False,
                target_new=2,
                detail_workers=1,
            )
            sleeps = []

            spider.fetch_page = lambda url, description="", referer="", session=None, **kwargs: "source_id=" + url.rsplit("/", 1)[-1]
            spider.parse_detail_page = lambda html: {
                "video_url": f"https://cdn.example.com/mp43/{html.split('=', 1)[1]}.mp4",
                "source_id": html.split("=", 1)[1],
            }
            spider.random_sleep = lambda min_sec, max_sec: sleeps.append((min_sec, max_sec))
            videos = [
                {
                    "title": f"Video {idx}",
                    "detail_url": f"https://www.91porn.com/{100 + idx}",
                    "thumb_url": "",
                    "viewkey": f"vk{idx}",
                    "source_id": str(100 + idx),
                }
                for idx in range(2)
            ]

            spider._process_video_list(videos, referer="https://www.91porn.com/v.php")

        self.assertEqual(spider.processed_videos, 2)
        self.assertEqual(sleeps, [(mod.MIN_DETAIL_DELAY, mod.MAX_DETAIL_DELAY)])
        self.assertLessEqual(mod.MAX_DETAIL_DELAY, 1.0)

    def test_log_replaces_unencodable_characters_in_console_output(self):
        mod = load_spider_module()
        spider = mod.Porn91Spider(output_file=os.devnull, resume=False)
        stream = self.StrictAsciiStream()
        old_stdout = sys.stdout
        sys.stdout = stream
        try:
            spider.log("title with ã and emoji 🚀")
        finally:
            sys.stdout = old_stdout

        self.assertIn("title with", stream.data)


if __name__ == "__main__":
    unittest.main()
