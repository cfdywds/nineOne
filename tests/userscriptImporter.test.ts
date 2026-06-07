import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scriptPath = new URL("../userscripts/video-site-video-importer.user.js", import.meta.url);

test("video importer userscript targets adult video pages and project import API", () => {
  assert.ok(existsSync(scriptPath), "userscript file should exist");
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /@name\s+Video Site 快速导入下载器/);
  assert.match(source, /@match\s+https:\/\/www\.xvideos\.com\/\*/);
  assert.match(source, /@match\s+https:\/\/www\.pornhub\.com\/\*/);
  assert.match(source, /@match\s+https:\/\/cn\.pornhub\.com\/\*/);
  assert.match(source, /@connect\s+127\.0\.0\.1/);
  assert.match(source, /@connect\s+localhost/);
  assert.match(source, /GM_xmlhttpRequest/);
  assert.match(source, /\/api\/import\/remote/);
});

test("video importer userscript distinguishes sources and prefers HD URLs", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /function\s+detectSourceSite/);
  assert.match(source, /hostname\.includes\("xvideos\.com"\)/);
  assert.match(source, /hostname\.includes\("pornhub\.com"\)/);
  assert.match(source, /function\s+collectVideoCandidates/);
  assert.match(source, /function\s+pickBestCandidate/);
  assert.match(source, /heightFromQuality/);
  assert.match(source, /sort\(\(a,\s*b\)\s*=>\s*scoreCandidate\(b\)\s*-\s*scoreCandidate\(a\)\)/);
  assert.match(source, /sourceSite/);
  assert.match(source, /quality/);
  assert.match(source, /thumbnailUrl/);
});

test("video importer userscript recognizes cn pornhub pages once matched by Tampermonkey", () => {
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/view_video.php?viewkey=abc",
    html: "",
  });

  assert.equal(api.detectSourceSite(), "pornhub");
  assert.equal(api.detectPageType(), "detail");
});

test("video importer userscript picks the high xvideos MP4 candidate", () => {
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/video123456/sample",
    html: `
      <script>
        html5player.setVideoUrlLow('https:\\/\\/cdn.example.com\\/clip-360p.mp4');
        html5player.setVideoUrlHigh('https:\\/\\/cdn.example.com\\/clip-720p.mp4');
      </script>
    `,
  });

  const candidates = api.collectVideoCandidates();
  const best = api.pickBestCandidate(candidates);

  assert.equal(best?.url, "https://cdn.example.com/clip-720p.mp4");
  assert.equal(best?.quality, "high");
  assert.equal(api.detectSourceSite(), "xvideos");
});

test("video importer userscript picks the highest pornhub mediaDefinitions candidate", () => {
  const api = loadUserscriptTestAPI({
    hostname: "www.pornhub.com",
    href: "https://www.pornhub.com/view_video.php?viewkey=abc",
    html: `
      <script>
        var mediaDefinitions = [
          {"quality":"480","videoUrl":"https:\\/\\/ph.example.com\\/clip-480.mp4"},
          {"quality":"1080","videoUrl":"https:\\/\\/ph.example.com\\/clip-1080.mp4"}
        ];
      </script>
    `,
  });

  const candidates = api.collectVideoCandidates();
  const best = api.pickBestCandidate(candidates);

  assert.equal(best?.url, "https://ph.example.com/clip-1080.mp4");
  assert.equal(best?.quality, "1080");
  assert.equal(api.detectSourceSite(), "pornhub");
});

test("video importer userscript reports accepted imports as background downloads", async () => {
  const statusMessages: string[] = [];
  let postedURL = "";
  let postedPayload: Record<string, unknown> = {};
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/video123456/sample",
    html: `
      <script>
        html5player.setVideoUrlHigh('https:\\/\\/cdn.example.com\\/clip-720p.mp4');
      </script>
    `,
    onStatus: (message) => statusMessages.push(message),
    gmXmlHttpRequest: (options) => {
      postedURL = options.url;
      postedPayload = JSON.parse(String(options.data || "{}")) as Record<string, unknown>;
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          id: "local-upload-import-1",
          href: "/video/local-upload-import-1",
        }),
      });
    },
  });

  api.importBestVideo();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(postedURL, "http://127.0.0.1:9191/api/import/remote");
  assert.equal(postedPayload.videoUrl, "https://cdn.example.com/clip-720p.mp4");
  const finalStatus = statusMessages.at(-1) || "";
  assert.match(finalStatus, /后台下载/);
  assert.doesNotMatch(finalStatus, /导入成功/);
});

test("video importer userscript replaces list selection controls with pasted URL download controls", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /data-role="pasted-video-urls"/);
  assert.match(source, /data-role="download-pasted"/);
  assert.match(source, />提交下载</);
  assert.doesNotMatch(source, /data-role="select-all"/);
  assert.doesNotMatch(source, /data-role="deselect-all"/);
  assert.doesNotMatch(source, /全选当前页|取消全选|导入已选/);
  assert.doesNotMatch(source, /video-site-importer-checkbox/);
});

test("video importer userscript downloads pasted detail page URLs through batch import", async () => {
  const statusMessages: string[] = [];
  let postedURL = "";
  let postedPayload: { videos?: Array<Record<string, unknown>> } = {};
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://www.xvideos.com/video123456/sample",
    onStatus: (message) => statusMessages.push(message),
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, [{ index: 0, status: "completed", progress: 100 }]);
      }
      if (options.method === "GET") {
        assert.equal(options.url, "https://www.xvideos.com/video123456/sample");
        options.onload({
          status: 200,
          responseText: `
            <html>
              <head>
                <meta property="og:title" content="Sample pasted video">
                <meta property="og:image" content="https://img.example.com/thumb.jpg">
              </head>
              <body>
                <script>
                  html5player.setVideoUrlLow('https:\\/\\/cdn.example.com\\/clip-360p.mp4');
                  html5player.setVideoUrlHigh('https:\\/\\/cdn.example.com\\/clip-720p.mp4');
                </script>
              </body>
            </html>
          `,
        });
        return;
      }
      postedURL = options.url;
      postedPayload = JSON.parse(String(options.data || "{}")) as { videos?: Array<Record<string, unknown>> };
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-test-session",
          progressToken: "test-progress-token",
          results: [{ index: 0, id: "local-upload-import-1", href: "/video/local-upload-import-1", status: "accepted" }],
        }),
      });
    },
  });

  assert.equal(typeof api.importPastedVideos, "function");
  await api.importPastedVideos();

  assert.equal(postedURL, "http://127.0.0.1:9191/api/import/remote/batch");
  assert.equal(postedPayload.videos?.length, 1);
  assert.equal(postedPayload.videos?.[0]?.pageUrl, "https://www.xvideos.com/video123456/sample");
  assert.equal(postedPayload.videos?.[0]?.videoUrl, "https://cdn.example.com/clip-720p.mp4");
  assert.equal(postedPayload.videos?.[0]?.title, "Sample pasted video");
  assert.equal(postedPayload.videos?.[0]?.thumbnailUrl, "https://img.example.com/thumb.jpg");
  assert.match(statusMessages.at(-1) || "", /导入进度|已提交后台下载|导入完成/);
});

test("video importer userscript stores progress session metadata for queued downloads", async () => {
  const storedValues = new Map<string, unknown>();
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-720p.mp4",
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) return undefined;
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-persisted-session",
          progressToken: "persisted-progress-token",
          results: [
            {
              index: 0,
              id: "local-upload-import-1",
              href: "/video/local-upload-import-1",
              status: "accepted",
            },
          ],
        }),
      });
      return undefined;
    },
  });

  await api.importPastedVideos?.();

  const queue = api.loadDownloadQueue?.() || [];
  assert.equal(queue[0]?.status, "queued");
  assert.equal(queue[0]?.sessionId, "import-persisted-session");
  assert.equal(queue[0]?.progressToken, "persisted-progress-token");
  assert.equal(queue[0]?.progressIndex, 0);
});

test("video importer userscript does not show accepted download locations before progress arrives", async () => {
  const statusMessages: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-720p.mp4",
    eventSourceEvents: [],
    onStatus: (message) => statusMessages.push(message),
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        throw new Error("progress should use EventSource when available");
      }
      assert.equal(options.method, "POST");
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-accepted-no-location",
          progressToken: "accepted-progress-token",
          results: [
            {
              index: 0,
              id: "local-upload-import-1",
              href: "/video/local-upload-import-1",
              status: "accepted",
            },
          ],
        }),
      });
      return undefined;
    },
  });

  await api.importPastedVideos?.();
  await new Promise((resolve) => setImmediate(resolve));

  const acceptedStatus = statusMessages.at(-1) || "";
  assert.match(acceptedStatus, /0%/);
  assert.doesNotMatch(acceptedStatus, /local-upload-import-1/);
});

test("video importer userscript shows per-download percentage and download locations", async () => {
  const statusMessages: string[] = [];
  const progressEvents = [
    {
      index: 0,
      status: "downloading",
      progress: 45,
      message: "正在下载视频...",
      videoId: "local-upload-import-1",
    },
    {
      index: 0,
      status: "completed",
      progress: 100,
      message: "导入成功",
      videoId: "local-upload-import-1",
    },
  ];
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-720p.mp4",
    onStatus: (message) => statusMessages.push(message),
    eventSourceEvents: progressEvents,
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, progressEvents);
      }
      assert.equal(options.method, "POST");
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-progress-location",
          progressToken: "location-progress-token",
          results: [
            {
              index: 0,
              id: "local-upload-import-1",
              href: "/video/local-upload-import-1",
              status: "accepted",
            },
          ],
        }),
      });
    },
  });

  await api.importPastedVideos?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    statusMessages.some(
      (message) =>
        message.includes("45%") &&
        message.includes("下载位置") &&
        message.includes("http://127.0.0.1:9191/video/local-upload-import-1")
    ),
    "status should include live progress percentage and predicted download location"
  );
  assert.match(statusMessages.at(-1) || "", /100%/);
  assert.match(statusMessages.at(-1) || "", /下载位置/);
});

test("video importer userscript falls back to GM_xmlhttpRequest progress with credentials", async () => {
  const statusMessages: string[] = [];
  const progressRequests: Array<{
    url: string;
    withCredentials?: boolean;
    anonymous?: boolean;
  }> = [];
  let progressRequestAborted = false;
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-720p.mp4",
    onStatus: (message) => statusMessages.push(message),
    eventSourceAvailable: false,
    gmXmlHttpRequest: (options) => {
      if (options.method === "GET" && options.url.includes("/api/import/progress/")) {
        progressRequests.push({
          url: options.url,
          withCredentials: options.withCredentials,
          anonymous: options.anonymous,
        });
        options.onprogress?.({
          responseText:
            'data: {"index":0,"status":"downloading","progress":45,"message":"正在下载视频...","videoId":"local-upload-import-1"}\n\n' +
            'data: {"index":0,"status":"completed","progress":100,"message":"导入成功","videoId":"local-upload-import-1"}\n\n',
        });
        return {
          abort() {
            progressRequestAborted = true;
          },
        };
      }
      assert.equal(options.method, "POST");
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-gm-progress",
          progressToken: "gm-progress-token",
          results: [
            {
              index: 0,
              id: "local-upload-import-1",
              href: "/video/local-upload-import-1",
              status: "accepted",
            },
          ],
        }),
      });
      return undefined;
    },
  });

  await api.importPastedVideos?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(progressRequests.length, 1);
  assert.equal(progressRequests[0]?.url, "http://127.0.0.1:9191/api/import/progress/import-gm-progress?token=gm-progress-token");
  assert.equal(progressRequests[0]?.withCredentials, true);
  assert.equal(progressRequests[0]?.anonymous, false);
  assert.equal(progressRequestAborted, true, "progress stream should be aborted after all items finish");
  assert.ok(statusMessages.some((message) => message.includes("45%")));
  assert.doesNotMatch(statusMessages.at(-1) || "", /进度订阅断开/);
});

test("video importer userscript prefers EventSource for live progress streaming", async () => {
  const statusMessages: string[] = [];
  const eventSourceURLs: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-720p.mp4",
    onStatus: (message) => statusMessages.push(message),
    onEventSourceOpen: (url) => eventSourceURLs.push(url),
    eventSourceEvents: [
      {
        index: 0,
        status: "completed",
        progress: 100,
        message: "导入成功",
        videoId: "local-upload-import-1",
      },
    ],
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        throw new Error("progress should use EventSource when available");
      }
      assert.equal(options.method, "POST");
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-eventsource-progress",
          progressToken: "progress-token-123",
          results: [
            {
              index: 0,
              id: "local-upload-import-1",
              href: "/video/local-upload-import-1",
              status: "accepted",
            },
          ],
        }),
      });
      return undefined;
    },
  });

  await api.importPastedVideos?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    eventSourceURLs[0],
    "http://127.0.0.1:9191/api/import/progress/import-eventsource-progress?token=progress-token-123"
  );
  assert.match(statusMessages.at(-1) || "", /导入完成：100%/);
});

test("video importer userscript resumes active queued downloads after page navigation", async () => {
  const queueKey = "video-site-importer-download-queue-v1";
  const storedValues = new Map<string, unknown>();
  storedValues.set(
    queueKey,
    JSON.stringify([
      {
        id: "queued-one",
        url: "https://www.xvideos.com/video123456/sample",
        title: "Previously submitted video",
        status: "downloading",
        progress: 0,
        sessionId: "import-resume-session",
        progressToken: "resume-progress-token",
        progressIndex: 0,
        href: "/video/local-upload-import-1",
        videoId: "local-upload-import-1",
      },
    ])
  );
  const progressRequests: string[] = [];
  const statusMessages: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    onStatus: (message) => statusMessages.push(message),
    eventSourceAvailable: false,
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        progressRequests.push(options.url);
        return emitProgressEvents(options, [
          {
            index: 0,
            status: "completed",
            progress: 100,
            message: "导入成功",
            videoId: "local-upload-import-1",
          },
        ]);
      }
      throw new Error("resume should not submit a new batch");
    },
  });

  await api.importPastedVideos?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(progressRequests, [
    "http://127.0.0.1:9191/api/import/progress/import-resume-session?token=resume-progress-token",
  ]);
  const queue = api.loadDownloadQueue?.() || [];
  assert.equal(queue[0]?.status, "completed");
  assert.equal(queue[0]?.progress, 100);
  assert.match(statusMessages.at(-1) || "", /导入完成：100%/);
});

test("video importer userscript returns legacy active downloads without progress sessions to pending", async () => {
  const queueKey = "video-site-importer-download-queue-v1";
  const storedValues = new Map<string, unknown>();
  storedValues.set(
    queueKey,
    JSON.stringify([
      {
        id: "legacy-active",
        url: "https://cn.pornhub.com/view_video.php?viewkey=ph61e594f4e042d",
        title: "Legacy active video",
        status: "downloading",
        progress: 0,
        href: "/video/local-upload-legacy",
        videoId: "local-upload-legacy",
      },
    ])
  );
  const statusMessages: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/video/search?search=sample",
    html: "",
    onStatus: (message) => statusMessages.push(message),
    eventSourceAvailable: false,
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
    gmXmlHttpRequest: () => {
      throw new Error("legacy active cleanup should not submit or subscribe");
    },
  });

  await api.importPastedVideos?.();

  const queue = api.loadDownloadQueue?.() || [];
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.progress, 0);
  assert.equal(queue[0]?.href, "");
  assert.match(statusMessages.at(-1) || "", /旧下载任务缺少进度会话/);
});

test("video importer userscript returns active downloads without progress tokens to pending", () => {
  const queueKey = "video-site-importer-download-queue-v1";
  const storedValues = new Map<string, unknown>();
  storedValues.set(
    queueKey,
    JSON.stringify([
      {
        id: "missing-token",
        url: "https://cn.pornhub.com/view_video.php?viewkey=ph61e594f4e042d",
        title: "Missing token video",
        status: "queued",
        progress: 0,
        sessionId: "import-old-session",
        progressIndex: 0,
        href: "/video/local-upload-old-session",
        videoId: "local-upload-old-session",
      },
    ])
  );
  const statusMessages: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/video/search?search=sample",
    html: "",
    onStatus: (message) => statusMessages.push(message),
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
  });

  api.recoverActiveDownloadQueue?.();

  const queue = api.loadDownloadQueue?.() || [];
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.progress, 0);
  assert.equal(queue[0]?.sessionId, "");
  assert.equal(queue[0]?.progressToken, "");
  assert.equal(queue[0]?.progressIndex, -1);
  assert.equal(queue[0]?.href, "");
  assert.match(statusMessages.at(-1) || "", /旧下载任务缺少进度会话/);
});

test("video importer userscript returns legacy queued downloads to pending during panel recovery", () => {
  const queueKey = "video-site-importer-download-queue-v1";
  const storedValues = new Map<string, unknown>();
  storedValues.set(
    queueKey,
    JSON.stringify([
      {
        id: "legacy-queued",
        url: "https://cn.pornhub.com/view_video.php?viewkey=ph61e594f4e042d",
        title: "Legacy queued video",
        status: "queued",
        progress: 0,
        href: "/video/local-upload-legacy-queued",
        videoId: "local-upload-legacy-queued",
      },
    ])
  );
  const statusMessages: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/video/search?search=sample",
    html: "",
    onStatus: (message) => statusMessages.push(message),
    eventSourceAvailable: false,
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
  });

  api.recoverActiveDownloadQueue?.();

  const queue = api.loadDownloadQueue?.() || [];
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.progress, 0);
  assert.equal(queue[0]?.href, "");
  assert.match(statusMessages.at(-1) || "", /旧下载任务缺少进度会话/);
});

test("video importer userscript returns stale recovered progress sessions to pending", async () => {
  const queueKey = "video-site-importer-download-queue-v1";
  const storedValues = new Map<string, unknown>();
  storedValues.set(
    queueKey,
    JSON.stringify([
      {
        id: "stale-session",
        url: "https://cn.pornhub.com/view_video.php?viewkey=ph61e594f4e042d",
        title: "Stale recovered video",
        status: "queued",
        progress: 0,
        sessionId: "import-stale-session",
        progressToken: "stale-progress-token",
        progressIndex: 0,
        href: "/video/local-upload-stale",
        videoId: "local-upload-stale",
      },
    ])
  );
  let didAbortProgress = false;
  const statusMessages: string[] = [];
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/video/search?search=sample",
    html: "",
    onStatus: (message) => statusMessages.push(message),
    eventSourceAvailable: false,
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout: () => undefined,
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return {
          abort() {
            didAbortProgress = true;
          },
        };
      }
      throw new Error("stale recovery should not submit a new batch");
    },
  });

  const result = api.recoverActiveDownloadQueue?.();

  assert.equal(result?.resumed, 1);
  assert.equal(didAbortProgress, true);
  const queue = api.loadDownloadQueue?.() || [];
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.progress, 0);
  assert.equal(queue[0]?.sessionId, "");
  assert.equal(queue[0]?.progressToken, "");
  assert.equal(queue[0]?.progressIndex, -1);
  assert.equal(queue[0]?.href, "");
  assert.equal(queue[0]?.videoId, "");
  assert.match(statusMessages.at(-1) || "", /进度会话已失效/);
});

test("video importer userscript stages current page links across pagination", () => {
  const storedValues = new Map<string, unknown>();
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample&p=1",
    html: "",
    gmGetValue: (key, fallback) => storedValues.get(key) ?? fallback,
    gmSetValue: (key, value) => {
      storedValues.set(key, value);
    },
  });

  const pageOne = api.collectListPageVideoLinksFromHTML?.(
    `<a href="/video123456/first">first</a><a href="/video.abcde/second">second</a>`,
    "https://www.xvideos.com/?k=sample&p=1"
  ) || [];
  const firstAdd = api.addDownloadQueueURLs?.(pageOne);
  const pageTwo = api.collectListPageVideoLinksFromHTML?.(
    `<a href="/video789/third">third</a><a href="/video123456/first">duplicate</a>`,
    "https://www.xvideos.com/?k=sample&p=2"
  ) || [];
  const secondAdd = api.addDownloadQueueURLs?.(pageTwo);
  const queued = api.loadDownloadQueue?.() || [];

  assert.equal(firstAdd?.added, 2);
  assert.equal(secondAdd?.added, 1);
  assert.equal(queued.length, 3);
  assert.deepEqual(
    queued.map((item) => item.url),
    [
      "https://www.xvideos.com/video123456/first",
      "https://www.xvideos.com/video.abcde/second",
      "https://www.xvideos.com/video789/third",
    ]
  );
});

test("video importer userscript renders a friendly download task list", () => {
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
  });

  const html = api.renderDownloadListHTML?.([
    {
      id: "one",
      url: "https://www.xvideos.com/video123456/first",
      title: "First staged video",
      status: "completed",
      progress: 100,
      href: "/video/local-upload-one",
    },
    {
      id: "two",
      url: "https://www.xvideos.com/video789/second",
      title: "Second staged video",
      status: "pending",
      progress: 0,
    },
  ]) || "";

  assert.match(html, /已完成/);
  assert.match(html, /100%/);
  assert.match(html, /待提交/);
  assert.match(html, /First staged video/);
  assert.match(html, /http:\/\/127\.0\.0\.1:9191\/video\/local-upload-one/);
});

test("video importer userscript hides predicted download links until imports complete", () => {
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
  });

  const html = api.renderDownloadListHTML?.([
    {
      id: "active",
      url: "https://www.xvideos.com/video123456/active",
      title: "Active video",
      status: "downloading",
      progress: 45,
      href: "/video/local-upload-active",
      videoId: "local-upload-active",
    },
    {
      id: "failed",
      url: "https://www.xvideos.com/video789/failed",
      title: "Failed video",
      status: "error",
      progress: 100,
      href: "/video/local-upload-failed",
      videoId: "local-upload-failed",
      error: "download failed",
    },
  ]) || "";

  assert.match(html, /完成后可用/);
  assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:9191\/video\/local-upload-active"/);
  assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:9191\/video\/local-upload-failed"/);
});

test("video importer userscript allows submitting new queued links while downloads are active", async () => {
  let postCount = 0;
  const postedPayloads: Array<{ videos?: Array<Record<string, unknown>> }> = [];
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-one.mp4",
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, [
          { index: 0, status: "downloading", progress: 30, videoId: `local-upload-${postCount}` },
        ]);
      }
      assert.equal(options.method, "POST");
      postCount++;
      postedPayloads.push(JSON.parse(String(options.data || "{}")) as { videos?: Array<Record<string, unknown>> });
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: `import-multi-submit-${postCount}`,
          progressToken: `multi-progress-token-${postCount}`,
          results: [{ index: 0, id: `local-upload-${postCount}`, href: `/video/local-upload-${postCount}`, status: "accepted" }],
        }),
      });
      return undefined;
    },
  });

  await api.importPastedVideos?.();
  api.setPastedVideoURLs?.("https://cdn.example.com/clip-two.mp4");
  await api.importPastedVideos?.();

  assert.equal(postCount, 2);
  assert.equal(postedPayloads[0]?.videos?.[0]?.videoUrl, "https://cdn.example.com/clip-one.mp4");
  assert.equal(postedPayloads[1]?.videos?.[0]?.videoUrl, "https://cdn.example.com/clip-two.mp4");
});

test("video importer userscript treats immediate batch errors as completed progress", async () => {
  const statusMessages: string[] = [];
  const progressEvents = [
    {
      index: 0,
      status: "completed",
      progress: 100,
      message: "导入成功",
      videoId: "local-upload-import-ok",
    },
  ];
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: "https://www.xvideos.com/?k=sample",
    html: "",
    pastedVideoURLs: "https://cdn.example.com/clip-ok.mp4\nhttps://cdn.example.com/clip-bad.mp4",
    onStatus: (message) => statusMessages.push(message),
    eventSourceEvents: progressEvents,
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, progressEvents);
      }
      assert.equal(options.method, "POST");
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-progress-with-error",
          progressToken: "error-progress-token",
          results: [
            { index: 0, id: "local-upload-import-ok", href: "/video/local-upload-import-ok", status: "accepted" },
            { index: 1, status: "error", error: "unsupported video extension" },
          ],
        }),
      });
    },
  });

  await api.importPastedVideos?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(statusMessages.at(-1) || "", /导入完成：100%/);
  assert.match(statusMessages.at(-1) || "", /1 成功，1 失败/);
});

test("video importer userscript treats xvideos dotted video URLs as current detail pages", async () => {
  const currentURL = "https://www.xvideos.com/video.ooelcflb2db/i_m_really_horny_and_my_husband_is_at_work";
  let didFetchCurrentPage = false;
  let postedPayload: { videos?: Array<Record<string, unknown>> } = {};
  const api = loadUserscriptTestAPI({
    hostname: "www.xvideos.com",
    href: currentURL,
    html: `
      <meta property="og:title" content="Current dotted xvideos page">
      <script>
        html5player.setVideoUrlHigh('https:\\/\\/cdn.example.com\\/current-720p.mp4');
      </script>
    `,
    pastedVideoURLs: currentURL,
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, [{ index: 0, status: "completed", progress: 100 }]);
      }
      if (options.method === "GET") {
        didFetchCurrentPage = true;
        options.onload({ status: 404, responseText: "404 page not found" });
        return;
      }
      postedPayload = JSON.parse(String(options.data || "{}")) as { videos?: Array<Record<string, unknown>> };
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-current-page",
          progressToken: "current-page-progress-token",
          results: [{ index: 0, id: "local-upload-import-1", href: "/video/local-upload-import-1", status: "accepted" }],
        }),
      });
    },
  });

  assert.equal(api.detectPageType(), "detail");
  await api.importPastedVideos();

  assert.equal(didFetchCurrentPage, false);
  assert.equal(postedPayload.videos?.[0]?.pageUrl, currentURL);
  assert.equal(postedPayload.videos?.[0]?.videoUrl, "https://cdn.example.com/current-720p.mp4");
});

test("video importer userscript uses page fetch for same-origin pasted pornhub detail pages", async () => {
  const detailURL = "https://cn.pornhub.com/view_video.php?viewkey=ph61e594f4e042d";
  let pageFetchURL = "";
  let pageFetchCredentials = "";
  let didUseGMGet = false;
  let postedPayload: { videos?: Array<Record<string, unknown>> } = {};
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/",
    html: "",
    pastedVideoURLs: detailURL,
    windowFetch: async (url, init) => {
      pageFetchURL = String(url);
      pageFetchCredentials = String(init?.credentials || "");
      return {
        ok: true,
        status: 200,
        text: async () => `
          <meta property="og:title" content="Fetched same-origin pornhub page">
          <script>
            var mediaDefinitions = [
              {"quality":"480","videoUrl":"https:\\/\\/ph.example.com\\/clip-480.mp4"},
              {"quality":"1080","videoUrl":"https:\\/\\/ph.example.com\\/clip-1080.mp4"}
            ];
          </script>
        `,
      };
    },
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, [{ index: 0, status: "completed", progress: 100 }]);
      }
      if (options.method === "GET") {
        didUseGMGet = true;
        options.onload({ status: 404, responseText: "404 page not found" });
        return;
      }
      postedPayload = JSON.parse(String(options.data || "{}")) as { videos?: Array<Record<string, unknown>> };
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-same-origin",
          progressToken: "same-origin-progress-token",
          results: [{ index: 0, id: "local-upload-import-1", href: "/video/local-upload-import-1", status: "accepted" }],
        }),
      });
    },
  });

  await api.importPastedVideos?.();

  assert.equal(pageFetchURL, detailURL);
  assert.equal(pageFetchCredentials, "include");
  assert.equal(didUseGMGet, false);
  assert.equal(postedPayload.videos?.[0]?.videoUrl, "https://ph.example.com/clip-1080.mp4");
});

test("video importer userscript resolves pornhub embed metadata before submitting", async () => {
  const detailURL = "https://cn.pornhub.com/view_video.php?viewkey=ph61e594f4e042d";
  const embedURL = "https://cn.pornhub.com/embed/694a56ede157f";
  const fetchedURLs: string[] = [];
  let postedPayload: { videos?: Array<Record<string, unknown>> } = {};
  const api = loadUserscriptTestAPI({
    hostname: "cn.pornhub.com",
    href: "https://cn.pornhub.com/",
    html: "",
    pastedVideoURLs: detailURL,
    windowFetch: async (url) => {
      fetchedURLs.push(String(url));
      if (String(url) === detailURL) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <meta property="og:title" content="Embed backed pornhub page">
            <meta property="og:video" content="${embedURL}">
          `,
        };
      }
      if (String(url) === embedURL) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <script>
              var mediaDefinitions = [
                {"quality":"480","videoUrl":"https:\\/\\/ph.example.com\\/embed-480.mp4"},
                {"quality":"720","videoUrl":"https:\\/\\/ph.example.com\\/embed-720.mp4"}
              ];
            </script>
          `,
        };
      }
      return { ok: false, status: 404, text: async () => "" };
    },
    gmXmlHttpRequest: (options) => {
      if (isProgressRequest(options)) {
        return emitProgressEvents(options, [{ index: 0, status: "completed", progress: 100 }]);
      }
      assert.equal(options.method, "POST");
      postedPayload = JSON.parse(String(options.data || "{}")) as { videos?: Array<Record<string, unknown>> };
      options.onload({
        status: 202,
        responseText: JSON.stringify({
          status: "accepted",
          sessionId: "import-embed-backed",
          progressToken: "embed-backed-progress-token",
          results: [{ index: 0, id: "local-upload-import-1", href: "/video/local-upload-import-1", status: "accepted" }],
        }),
      });
      return undefined;
    },
  });

  await api.importPastedVideos?.();

  assert.deepEqual(fetchedURLs, [detailURL, embedURL]);
  assert.equal(postedPayload.videos?.[0]?.videoUrl, "https://ph.example.com/embed-720.mp4");
  assert.notEqual(postedPayload.videos?.[0]?.videoUrl, embedURL);
});

type UserscriptTestAPI = {
  detectSourceSite: () => string;
  detectPageType: () => string;
  collectVideoCandidates: () => Array<{ url: string; quality?: string }>;
  pickBestCandidate: (
    candidates: Array<{ url: string; quality?: string }>
  ) => { url: string; quality?: string } | null;
  importBestVideo: () => void;
  parsePastedVideoURLs?: (value: string) => string[];
  importPastedVideos?: () => Promise<void>;
  collectListPageVideoLinksFromHTML?: (html: string, pageURL: string) => string[];
  addDownloadQueueURLs?: (urls: string[]) => { added: number; skipped: number; total: number };
  recoverActiveDownloadQueue?: () => { resumed: number; marked: number };
  loadDownloadQueue?: () => Array<{
    id: string;
    url: string;
    title?: string;
    status?: string;
    progress?: number;
    href?: string;
    sessionId?: string;
    progressToken?: string;
    progressIndex?: number;
  }>;
  renderDownloadListHTML?: (items: Array<Record<string, unknown>>) => string;
  setPastedVideoURLs?: (value: string) => void;
};

function isProgressRequest(options: { method?: string; url: string }) {
  return options.method === "GET" && options.url.includes("/api/import/progress/");
}

function emitProgressEvents(
  options: { onprogress?: (response: { responseText?: string }) => void },
  events: Array<Record<string, unknown>>
) {
  options.onprogress?.({
    responseText: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  });
  return {
    abort() {
      return undefined;
    },
  };
}

function loadUserscriptTestAPI(input: {
  hostname: string;
  href: string;
  html: string;
  pastedVideoURLs?: string;
  eventSourceEvents?: Array<Record<string, unknown>>;
  eventSourceAvailable?: boolean;
  onEventSourceOpen?: (url: string) => void;
  onStatus?: (message: string) => void;
  gmGetValue?: (key: string, fallback: unknown) => unknown;
  gmSetValue?: (key: string, value: unknown) => void;
  gmXmlHttpRequest?: (options: {
    method?: string;
    url: string;
    data?: string;
    anonymous?: boolean;
    withCredentials?: boolean;
    onload: (response: { status: number; responseText?: string }) => void;
    onprogress?: (response: { responseText?: string }) => void;
    onerror?: () => void;
    ontimeout?: () => void;
  }) => void | { abort?: () => void };
  setTimeout?: (callback: () => void, delay?: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  windowFetch?: (
    url: string,
    init?: { credentials?: string }
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}): UserscriptTestAPI {
  const source = readFileSync(scriptPath, "utf8").replace(
    /\}\)\(\);\s*$/,
    `globalThis.__videoSiteImporterTestAPI = {
      detectSourceSite,
      detectPageType,
      collectVideoCandidates,
      pickBestCandidate,
      heightFromQuality,
      importBestVideo,
      parsePastedVideoURLs: typeof parsePastedVideoURLs === "function" ? parsePastedVideoURLs : undefined,
      importPastedVideos: typeof importPastedVideos === "function" ? importPastedVideos : undefined,
      collectListPageVideoLinksFromHTML: typeof collectListPageVideoLinksFromHTML === "function" ? collectListPageVideoLinksFromHTML : undefined,
      addDownloadQueueURLs: typeof addDownloadQueueURLs === "function" ? addDownloadQueueURLs : undefined,
      recoverActiveDownloadQueue: typeof recoverActiveDownloadQueue === "function" ? recoverActiveDownloadQueue : undefined,
      loadDownloadQueue: typeof loadDownloadQueue === "function" ? loadDownloadQueue : undefined,
      renderDownloadListHTML: typeof renderDownloadListHTML === "function" ? renderDownloadListHTML : undefined,
    };
  })();`
  );
  const statusNode = {
    set textContent(value: string) {
      input.onStatus?.(value);
    },
    get textContent() {
      return "";
    },
  };
  const pastedVideoURLsNode = {
    value: input.pastedVideoURLs || "",
  };
  const disabledButtonNode = {
    disabled: false,
  };
  class TestEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    url: string;

    constructor(url: string) {
      this.url = url;
      input.onEventSourceOpen?.(url);
      setImmediate(() => {
        const events = input.eventSourceEvents || [{ index: 0, status: "completed" }];
        for (const event of events) {
          this.onmessage?.({
            data: JSON.stringify(event),
          });
        }
      });
    }

    close() {
      return undefined;
    }
  }
  const context = {
    URL,
    RegExp,
    Number,
    String,
    Set,
    Error,
    Promise,
    JSON,
    decodeURIComponent,
    setTimeout: input.setTimeout || setTimeout,
    clearTimeout: input.clearTimeout || clearTimeout,
    setImmediate,
    console,
    EventSource: input.eventSourceAvailable === false ? undefined : TestEventSource,
    GM_getValue: input.gmGetValue || ((_key: string, fallback: string) => fallback),
    GM_setValue: input.gmSetValue || (() => undefined),
    GM_xmlhttpRequest: input.gmXmlHttpRequest || (() => undefined),
    window: {
      location: {
        hostname: input.hostname,
        href: input.href,
        pathname: new URL(input.href).pathname,
      },
      prompt: () => "",
      fetch: input.windowFetch,
    },
    document: {
      readyState: "loading",
      title: "Imported test video - XVIDEOS.COM",
      documentElement: { innerHTML: input.html },
      addEventListener: () => undefined,
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: (selector: string) => {
        if (selector === "#video-site-importer-panel [data-role='status']") return statusNode;
        if (selector === '[data-role="pasted-video-urls"]') return pastedVideoURLsNode;
        if (selector === '[data-role="download-pasted"]') return disabledButtonNode;
        return null;
      },
      createElement: () => ({
        innerHTML: "",
        textContent: "",
        addEventListener: () => undefined,
        querySelector: () => ({ addEventListener: () => undefined }),
      }),
    },
  };

  vm.runInNewContext(source, context, { filename: "video-site-video-importer.user.js" });
  const api = (context as unknown as { __videoSiteImporterTestAPI?: UserscriptTestAPI })
    .__videoSiteImporterTestAPI;
  assert.ok(api, "userscript should expose test API after instrumentation");
  api.setPastedVideoURLs = (value: string) => {
    pastedVideoURLsNode.value = value;
  };
  return api;
}
