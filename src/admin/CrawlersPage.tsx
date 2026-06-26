import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  CircleStop,
  Download,
  FileCode2,
  Link as LinkIcon,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  TestTube,
  Trash2,
  Upload,
} from "lucide-react";
import * as api from "./api";
import { Modal } from "./Modal";
import { ConfirmModal } from "./ConfirmModal";
import { useToast } from "./ToastContext";
import { generationStateClass, generationStateLabel } from "./drive/constants";
import { CrawlerUploadTargetField } from "./drive/CrawlerUploadTargetField";
import { SpiderIcon } from "./icons/SpiderIcon";

const BUSY_STATES = new Set(["scanning", "generating", "uploading", "queued"]);
const POLL_INTERVAL_MS = 5000;
const UPLOAD_TARGET_KINDS = new Set(["p115", "pikpak", "p123", "googledrive", "onedrive", "wopan", "guangyapan"]);

function statusBusy(status?: api.DriveGenerationStatus) {
  return BUSY_STATES.has(status?.state ?? "");
}

function crawlerBusy(crawler: api.AdminCrawler) {
  return (
    statusBusy(crawler.scanGenerationStatus) ||
    statusBusy(crawler.thumbnailGenerationStatus) ||
    statusBusy(crawler.previewGenerationStatus) ||
    statusBusy(crawler.fingerprintGenerationStatus) ||
    statusBusy(crawler.uploadGenerationStatus)
  );
}

export function CrawlersPage() {
  const [list, setList] = useState<api.AdminCrawler[]>([]);
  const [uploadTargets, setUploadTargets] = useState<api.AdminDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState("");
  const [runningId, setRunningId] = useState("");
  const [uploadingId, setUploadingId] = useState("");
  const [stoppingId, setStoppingId] = useState("");
  const [togglingTeaserId, setTogglingTeaserId] = useState("");
  // undefined = 编辑器关闭；null = 新建；其余 = 编辑已有爬虫
  const [editorTarget, setEditorTarget] = useState<api.AdminCrawler | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<api.AdminCrawler | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refreshingRef = useRef(false);
  const { show } = useToast();

  const refresh = useCallback(
    async (silent = false) => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      if (!silent) setLoading(true);
      try {
        const [data, drives] = await Promise.all([api.listCrawlers(), api.listDrives()]);
        setList(data);
        setUploadTargets(drives.filter((d) => UPLOAD_TARGET_KINDS.has(d.kind)));
      } catch (e) {
        if (!silent) show(e instanceof Error ? e.message : "加载爬虫失败", "error");
      } finally {
        refreshingRef.current = false;
        if (!silent) setLoading(false);
      }
    },
    [show]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 有任务进行中时自动轮询，页面切到后台时暂停
  const anyBusy = useMemo(() => list.some(crawlerBusy), [list]);
  useEffect(() => {
    if (!anyBusy) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [anyBusy, refresh]);

  const stats = useMemo(
    () => ({
      total: list.length,
      ready: list.filter((item) => item.status === "ok").length,
      busy: list.filter(crawlerBusy).length,
      error: list.filter((item) => item.status === "error").length,
    }),
    [list]
  );

  async function run(crawler: api.AdminCrawler) {
    setRunningId(crawler.id);
    try {
      const resp = await api.runCrawler(crawler.id);
      if (!resp.accepted) {
        show(resp.message || "当前爬虫有正在进行的任务", "info");
        return;
      }
      show("已触发抓取任务", "success");
      await refresh(true);
    } catch (e) {
      show(e instanceof Error ? e.message : "触发失败", "error");
    } finally {
      setRunningId("");
    }
  }

  async function uploadVideos(crawler: api.AdminCrawler) {
    setUploadingId(crawler.id);
    try {
      const resp = await api.uploadCrawlerVideos(crawler.id);
      if (!resp.accepted) {
        show(resp.message || "当前爬虫暂不满足上传条件", "info");
        return;
      }
      show("已触发上传任务", "success");
      await refresh(true);
    } catch (e) {
      show(e instanceof Error ? e.message : "触发上传失败", "error");
    } finally {
      setUploadingId("");
    }
  }

  async function stop(crawler: api.AdminCrawler) {
    setStoppingId(crawler.id);
    try {
      const resp = await api.stopCrawlerTasks(crawler.id);
      show(resp.stopped ? "已请求停止任务" : "当前没有可停止任务", "info");
      await refresh(true);
    } catch (e) {
      show(e instanceof Error ? e.message : "停止失败", "error");
    } finally {
      setStoppingId("");
    }
  }

  async function toggleTeaser(crawler: api.AdminCrawler) {
    const next = !crawler.teaserEnabled;
    setTogglingTeaserId(crawler.id);
    setList((prev) => prev.map((item) => (item.id === crawler.id ? { ...item, teaserEnabled: next } : item)));
    try {
      const resp = await api.setDriveTeaserEnabled(crawler.id, next);
      setList((prev) => prev.map((item) => (item.id === crawler.id ? { ...item, teaserEnabled: resp.teaserEnabled } : item)));
      show(resp.teaserEnabled ? `已开启「${crawler.name}」预览视频生成` : `已关闭「${crawler.name}」预览视频生成`, "success");
      await refresh(true);
    } catch (e) {
      setList((prev) => prev.map((item) => (item.id === crawler.id ? { ...item, teaserEnabled: crawler.teaserEnabled } : item)));
      show(e instanceof Error ? e.message : "切换预览视频失败", "error");
    } finally {
      setTogglingTeaserId("");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const resp = await api.deleteCrawler(deleteTarget.id);
      if (resp.warning) {
        show(`已删除爬虫配置，但脚本文件清理失败：${resp.warning}`, "error");
      } else {
        show("已删除爬虫，已爬取的视频保留", "success");
      }
      setDeleteTarget(null);
      if (expandedId === deleteTarget.id) setExpandedId("");
      await refresh(true);
    } catch (e) {
      show(e instanceof Error ? e.message : "删除失败", "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="admin-page">
      <header className="admin-page__header">
        <div>
          <h1 className="admin-page__title">爬虫管理</h1>
        </div>
        <div className="admin-detail-actions-inline">
          <button className="admin-btn" onClick={() => refresh()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "admin-spin" : undefined} /> 刷新
          </button>
          <button className="admin-btn is-primary" onClick={() => setEditorTarget(null)}>
            <Plus size={14} /> 添加爬虫
          </button>
        </div>
      </header>

      <div className="admin-crawler-console">
        <div className="admin-crawler-overview">
          <CrawlerMetric label="已配置" value={stats.total} icon={<SpiderIcon size={16} />} />
          <CrawlerMetric label="已就绪" value={stats.ready} icon={<Activity size={16} />} tone="ok" />
          <CrawlerMetric label="任务进行中" value={stats.busy} icon={<RefreshCw size={16} />} tone="info" />
          <CrawlerMetric label="异常" value={stats.error} icon={<AlertTriangle size={16} />} tone="error" />
        </div>

        <div className="admin-card admin-crawler-list">
          <div className="admin-crawler-list__head">
            <header className="admin-card__title">
              <SpiderIcon size={16} /> 已配置爬虫
            </header>
            {anyBusy && (
              <span className="admin-crawler-list__live">
                <RefreshCw size={12} className="admin-spin" /> 任务进行中，自动刷新
              </span>
            )}
          </div>
          {loading ? (
            <div className="admin-loading-state">
              <RefreshCw size={18} className="admin-spin" />
              <span>加载中...</span>
            </div>
          ) : list.length === 0 ? (
            <div className="admin-crawler-empty">
              <SpiderIcon size={28} />
              <strong>暂无爬虫</strong>
              <p>导入脚本 → 测试运行 → 保存启用，三步接入一个新片源</p>
              <button className="admin-btn is-primary" type="button" onClick={() => setEditorTarget(null)}>
                <Plus size={13} /> 添加爬虫
              </button>
            </div>
          ) : (
            <div className="admin-crawler-table">
              {list.map((crawler) => (
                <CrawlerRow
                  key={crawler.id}
                  crawler={crawler}
                  expanded={expandedId === crawler.id}
                  running={runningId === crawler.id}
                  uploading={uploadingId === crawler.id}
                  stopping={stoppingId === crawler.id}
                  togglingTeaser={togglingTeaserId === crawler.id}
                  onToggle={() => setExpandedId(expandedId === crawler.id ? "" : crawler.id)}
                  onRun={() => run(crawler)}
                  onUpload={() => uploadVideos(crawler)}
                  onStop={() => stop(crawler)}
                  onToggleTeaser={() => toggleTeaser(crawler)}
                  onEdit={() => setEditorTarget(crawler)}
                  onDelete={() => setDeleteTarget(crawler)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <CrawlerEditorModal
        open={editorTarget !== undefined}
        crawler={editorTarget ?? null}
        uploadTargets={uploadTargets}
        onClose={() => setEditorTarget(undefined)}
        onSaved={() => {
          setEditorTarget(undefined);
          refresh(true);
        }}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除爬虫"
        message={`确定删除爬虫「${deleteTarget?.name ?? ""}」？`}
        details={["爬虫配置和脚本文件会被删除", "已爬取的视频、封面和预览会保留"]}
        confirmText="删除"
        danger
        loading={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </section>
  );
}

function CrawlerMetric({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone?: "ok" | "info" | "error" }) {
  return (
    <div className={`admin-crawler-metric ${tone ? `is-${tone}` : ""}`}>
      <span className="admin-crawler-metric__icon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CrawlerRow({
  crawler,
  expanded,
  running,
  uploading,
  stopping,
  togglingTeaser,
  onToggle,
  onRun,
  onUpload,
  onStop,
  onToggleTeaser,
  onEdit,
  onDelete,
}: {
  crawler: api.AdminCrawler;
  expanded: boolean;
  running: boolean;
  uploading: boolean;
  stopping: boolean;
  togglingTeaser: boolean;
  onToggle: () => void;
  onRun: () => void;
  onUpload: () => void;
  onStop: () => void;
  onToggleTeaser: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const busy = crawlerBusy(crawler);
  const uploadButtonTitle = uploading ? "上传请求处理中" : "上传本地爬虫视频到已配置的上传网盘";
  return (
    <div className={`admin-crawler-row ${expanded ? "is-expanded" : ""}`}>
      <div className="admin-crawler-row__line">
        <button type="button" className="admin-crawler-row__main" onClick={onToggle} aria-expanded={expanded}>
          <span className="admin-crawler-row__brand">
            <SpiderIcon size={16} />
          </span>
          <span className="admin-crawler-row__title-wrap">
            <strong>{crawler.name}</strong>
            <span>
              上次抓取 {formatLastCrawl(crawler.lastCrawlAt)} · 每次新增 {crawler.targetNew || "10"} 条 · 累计爬取 {crawler.totalCrawledCount ?? 0} 条
            </span>
          </span>
          <ChevronDown size={16} className="admin-crawler-row__chevron" />
        </button>
        <div className="admin-crawler-row__actions">
          <button
            className="admin-btn admin-crawler-preview-card-toggle"
            type="button"
            onClick={onToggleTeaser}
            disabled={togglingTeaser}
            aria-pressed={crawler.teaserEnabled}
            title={crawler.teaserEnabled ? "关闭后，该爬虫新爬取的视频不再生成预览视频" : "开启后，该爬虫新爬取的视频会生成预览视频"}
          >
            {crawler.teaserEnabled ? <Power size={13} /> : <PowerOff size={13} />}
            <span>{crawler.teaserEnabled ? "预览：开" : "预览：关"}</span>
          </button>
          {busy ? (
            <button className="admin-btn is-stop" type="button" onClick={onStop} disabled={stopping}>
              <CircleStop size={13} /> {stopping ? "停止中..." : "停止"}
            </button>
          ) : (
            <button className="admin-btn" type="button" onClick={onRun} disabled={running}>
              <Download size={13} /> {running ? "触发中..." : "立即抓取"}
            </button>
          )}
          <button
            className="admin-btn"
            type="button"
            onClick={onUpload}
            title={uploadButtonTitle}
          >
            <Upload size={13} /> {uploading ? "上传中..." : "上传视频"}
          </button>
          <button className="admin-btn" type="button" onClick={onEdit}>
            <Pencil size={13} /> 编辑
          </button>
          <button className="admin-btn is-danger admin-crawler-row__delete" type="button" onClick={onDelete} aria-label="删除爬虫" title="删除爬虫">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {expanded && <CrawlerDetail crawler={crawler} />}
    </div>
  );
}

function CrawlerDetail({ crawler }: { crawler: api.AdminCrawler }) {
  const scan = crawler.scanGenerationStatus;
  const upload = crawlerUploadDisplayStatus(crawler);
  return (
    <div className="admin-crawler-detail">
      <div className="admin-crawler-detail__grid">
        <GenStageCard
          label="抓取"
          status={scan}
          stateText={scan?.state === "scanning" ? "抓取中" : generationStateLabel(scan?.state || "idle")}
          counts={[
            { label: "累计爬取", value: crawler.totalCrawledCount ?? 0 },
            { label: "本轮检查", value: scan?.scannedCount ?? 0 },
            { label: "本轮新增", value: scan?.addedCount ?? 0 },
          ]}
        />
        <GenStageCard
          label="上传"
          status={upload.status}
          stateText={upload.text}
          counts={[
            { label: "已上传", value: crawler.migratedVideoCount ?? 0 },
            { label: crawler.uploadDriveId ? "待上传" : "本地保留", value: crawler.localVideoCount ?? 0 },
            { label: "本轮处理", value: upload.status.doneCount ?? 0 },
            { label: "本轮总数", value: upload.status.totalCount ?? 0 },
          ]}
        />
        <GenStageCard
          label="封面"
          status={crawler.thumbnailGenerationStatus}
          counts={[
            { label: "已生成", value: crawler.thumbnailReadyCount },
            { label: "待生成", value: crawler.thumbnailPendingCount },
            { label: "失败", value: crawler.thumbnailFailedCount, tone: "danger" },
          ]}
        />
        <GenStageCard
          label="预览视频"
          status={crawler.previewGenerationStatus}
          counts={[
            { label: "已生成", value: crawler.teaserReadyCount },
            { label: "待生成", value: crawler.teaserPendingCount },
            { label: "失败", value: crawler.teaserFailedCount, tone: "danger" },
          ]}
        />
        <GenStageCard
          label="视频指纹"
          status={crawler.fingerprintGenerationStatus}
          counts={[
            { label: "已生成", value: crawler.fingerprintReadyCount },
            { label: "待生成", value: crawler.fingerprintPendingCount },
            { label: "失败", value: crawler.fingerprintFailedCount, tone: "danger" },
          ]}
        />
      </div>
      {crawler.lastError && (
        <div className="admin-crawler-detail__error">
          <AlertTriangle size={14} />
          <span>{crawler.lastError}</span>
        </div>
      )}
    </div>
  );
}

function crawlerUploadDisplayStatus(crawler: api.AdminCrawler): {
  status: api.DriveGenerationStatus;
  text: string;
} {
  const live = crawler.uploadGenerationStatus;
  const state = live?.state || "idle";
  const localCount = crawler.localVideoCount ?? 0;
  const totalCount = crawler.totalCrawledCount ?? 0;
  const base: api.DriveGenerationStatus = {
    state,
    currentTitle: live?.currentTitle,
    queueLength: live?.queueLength ?? 0,
    cooldownUntil: live?.cooldownUntil,
    scannedCount: live?.scannedCount ?? 0,
    addedCount: live?.addedCount ?? 0,
    doneCount: live?.doneCount ?? 0,
    totalCount: live?.totalCount ?? 0,
  };

  if (!crawler.uploadDriveId) {
    return {
      status: base,
      text: localCount > 0 ? "本地保存" : generationStateLabel(state),
    };
  }
  if (state === "uploading") {
    return { status: base, text: "上传中" };
  }
  if (state === "queued") {
    return { status: base, text: "排队中" };
  }
  if (localCount > 0) {
    return {
      status: { ...base, state: "queued", queueLength: localCount },
      text: "待上传",
    };
  }
  if (totalCount > 0) {
    return { status: base, text: "完成" };
  }
  return { status: base, text: generationStateLabel(state) };
}

function GenStageCard({
  label,
  status,
  stateText,
  counts,
}: {
  label: string;
  status?: api.DriveGenerationStatus;
  stateText?: string;
  counts: Array<{ label: string; value: number; tone?: "danger" }>;
}) {
  const state = status?.state || "idle";
  return (
    <div className="admin-gen-col">
      <div className="admin-gen-col__head">
        <span className="admin-gen-col__label">{label}</span>
        <span className={`admin-status admin-generation-state is-${generationStateClass(state)}`}>
          {stateText ?? generationStateLabel(state)}
        </span>
      </div>
      {status?.currentTitle && <div className="admin-gen-col__detail">{status.currentTitle}</div>}
      <div className="admin-gen-col__counts">
        {counts.map((count) => (
          <div className="admin-gen-col__count" key={count.label}>
            <span>{count.label}</span>
            <strong className={count.tone === "danger" && count.value > 0 ? "is-danger" : undefined}>{count.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 编辑器 ----------

type EditorForm = {
  scriptPath: string;
  scriptSourceUrl: string;
  name: string;
  targetNew: string;
  proxy: string;
  uploadDriveId: string;
};

function CrawlerEditorModal({
  open,
  crawler,
  uploadTargets,
  onClose,
  onSaved,
}: {
  open: boolean;
  crawler: api.AdminCrawler | null;
  uploadTargets: api.AdminDrive[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = crawler !== null;
  const [form, setForm] = useState<EditorForm>({
    scriptPath: "",
    scriptSourceUrl: "",
    name: "",
    targetNew: "10",
    proxy: "",
    uploadDriveId: "",
  });
  const [scriptURL, setScriptURL] = useState("");
  const [importing, setImporting] = useState(false);
  const [replacingScript, setReplacingScript] = useState(false);
  // 已通过原链接拉取过新脚本（路径不变，内容已更新）
  const [scriptUpdated, setScriptUpdated] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<api.CrawlerDryRunResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { show } = useToast();

  useEffect(() => {
    if (!open) return;
    setForm({
      scriptPath: crawler?.scriptPath ?? "",
      scriptSourceUrl: crawler?.scriptSourceUrl ?? "",
      name: crawler?.name ?? "",
      targetNew: crawler?.targetNew || "10",
      proxy: crawler?.proxy ?? "",
      uploadDriveId: crawler?.uploadDriveId ?? "",
    });
    setScriptURL("");
    setTestResult(null);
    setDragOver(false);
    setReplacingScript(false);
    setScriptUpdated(false);
  }, [open, crawler]);

  // 编辑模式下默认收起导入区，点「替换脚本」再展开
  const showImportArea = !isEdit || replacingScript;
  const scriptChanged = form.scriptPath !== (crawler?.scriptPath ?? "");

  function set<K extends keyof EditorForm>(key: K, value: EditorForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function cancelReplace() {
    setForm((prev) => ({
      ...prev,
      scriptPath: crawler?.scriptPath ?? "",
      scriptSourceUrl: crawler?.scriptSourceUrl ?? "",
      name: crawler?.name ?? "",
    }));
    setScriptURL("");
    setTestResult(null);
    setReplacingScript(false);
  }

  async function importFile(file: File | null | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".py")) {
      show("仅支持 .py 脚本文件", "error");
      return;
    }
    setImporting(true);
    try {
      const resp = await api.importCrawlerScriptFile(file);
      setForm((prev) => ({ ...prev, scriptPath: resp.scriptPath, name: resp.name, scriptSourceUrl: "" }));
      setTestResult(null);
      show("脚本已导入", "success");
    } catch (e) {
      show(e instanceof Error ? e.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  }

  async function importURL() {
    const url = scriptURL.trim();
    if (!url) {
      show("请填写脚本链接", "error");
      return;
    }
    setImporting(true);
    try {
      const resp = await api.importCrawlerScriptURL(url);
      setForm((prev) => ({
        ...prev,
        scriptPath: resp.scriptPath,
        name: resp.name,
        scriptSourceUrl: resp.sourceUrl || url,
      }));
      setScriptURL("");
      setTestResult(null);
      show("脚本已导入，保存后可随时从原链接更新", "success");
    } catch (e) {
      show(e instanceof Error ? e.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  }

  async function updateFromSource() {
    const url = form.scriptSourceUrl.trim();
    if (!url) return;
    setImporting(true);
    try {
      const resp = await api.importCrawlerScriptURL(url);
      setForm((prev) => ({
        ...prev,
        scriptPath: resp.scriptPath,
        name: resp.name,
        scriptSourceUrl: resp.sourceUrl || url,
      }));
      setTestResult(null);
      setScriptUpdated(true);
      show("已从原链接拉取最新脚本", "success");
    } catch (e) {
      show(e instanceof Error ? e.message : "从原链接更新失败", "error");
    } finally {
      setImporting(false);
    }
  }

  async function test() {
    const scriptPath = form.scriptPath.trim();
    if (!scriptPath) {
      show("请先导入爬虫脚本", "error");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testCrawlerScript({ scriptPath, proxy: form.proxy.trim() });
      setTestResult(result);
      if (result.ok) {
        show("测试通过", "success");
      } else {
        show(crawlerTestFailure(result) || "测试失败", "error");
      }
    } catch (e) {
      show(e instanceof Error ? e.message : "测试失败", "error");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!form.scriptPath.trim()) {
      show("请先导入爬虫脚本", "error");
      return;
    }
    const target = form.targetNew.trim();
    if (target && (!/^\d+$/.test(target) || Number(target) < 1)) {
      show("每次新增视频数需为正整数", "error");
      return;
    }
    setSaving(true);
    try {
      const resp = await api.upsertCrawler({
        id: crawler?.id,
        scriptPath: form.scriptPath.trim(),
        scriptSourceUrl: form.scriptSourceUrl.trim(),
        targetNew: target,
        proxy: form.proxy.trim(),
        uploadDriveId: form.uploadDriveId,
      });
      if (resp.warning) {
        show(`已保存，但初始化失败：${resp.warning}`, "error");
      } else {
        show("已保存", "success");
      }
      onSaved();
    } catch (e) {
      show(e instanceof Error ? e.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (importing) return;
    importFile(e.dataTransfer.files?.[0]);
  }

  const footerNote = !form.scriptPath
    ? { text: "导入脚本后才能保存", tone: "" }
    : testResult?.ok
      ? { text: "测试通过", tone: "is-ok" }
      : testResult
        ? { text: "测试未通过，建议检查脚本", tone: "is-error" }
        : scriptChanged || scriptUpdated
          ? { text: "建议先运行测试再保存", tone: "" }
          : null;

  return (
    <Modal
      open={open}
      title={isEdit ? `编辑爬虫 · ${crawler?.name ?? ""}` : "添加爬虫"}
      onClose={onClose}
      className="admin-modal--crawler"
      footer={
        <>
          {footerNote && <span className={`admin-modal__footer-note ${footerNote.tone}`}>{footerNote.text}</span>}
          <button type="button" className="admin-btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="admin-btn is-primary" onClick={save} disabled={saving || !form.scriptPath}>
            {saving ? "保存中..." : "保存"}
          </button>
        </>
      }
    >
      <div className="admin-crawler-editor">
        <div className="admin-crawler-editor__summary" aria-label="爬虫配置状态">
          <CrawlerEditorSummaryItem
            label="脚本"
            value={form.scriptPath ? form.name || "已导入" : "未导入"}
            tone={form.scriptPath ? "ok" : "muted"}
            icon={<FileCode2 size={13} />}
          />
          <CrawlerEditorSummaryItem
            label="测试"
            value={testResult?.ok ? "已通过" : testResult ? "未通过" : "未测试"}
            tone={testResult?.ok ? "ok" : testResult ? "error" : "muted"}
            icon={<TestTube size={13} />}
          />
          <CrawlerEditorSummaryItem
            label="每轮新增"
            value={`${form.targetNew.trim() || "10"} 条`}
            tone="muted"
            icon={<Download size={13} />}
          />
        </div>

        <div className="admin-crawler-editor__grid">
          <section className="admin-crawler-panel admin-crawler-panel--script">
            <header className="admin-crawler-panel__head">
              <span className="admin-crawler-panel__icon">
                <FileCode2 size={15} />
              </span>
              <div>
                <strong>脚本来源</strong>
                <span>{isEdit ? "管理当前脚本或替换版本" : "选择本地文件或脚本链接"}</span>
              </div>
            </header>

            <input
              ref={fileInputRef}
              type="file"
              accept=".py,text/x-python"
              hidden
              onChange={(e) => {
                importFile(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />

            {form.scriptPath && (
              <div className={`admin-crawler-current-script${isEdit && scriptChanged ? " is-replaced" : ""}`}>
                <div className="admin-crawler-current-script__main">
                  <span className="admin-crawler-current-script__icon">
                    <FileCode2 size={16} />
                  </span>
                  <div>
                    <div className="admin-crawler-current-script__title">
                      <strong>{form.name || "未命名脚本"}</strong>
                      {isEdit && scriptChanged && <em>新脚本</em>}
                      {isEdit && !scriptChanged && scriptUpdated && <em>已更新</em>}
                    </div>
                  </div>
                </div>

                {isEdit && (
                  <div className="admin-crawler-current-script__actions">
                    {replacingScript ? (
                      <button type="button" className="admin-btn" onClick={cancelReplace} disabled={importing}>
                        取消替换
                      </button>
                    ) : (
                      <>
                        {form.scriptSourceUrl && (
                          <button
                            type="button"
                            className="admin-btn"
                            onClick={updateFromSource}
                            disabled={importing}
                            title={`从 ${form.scriptSourceUrl} 重新拉取脚本`}
                          >
                            <RefreshCw size={12} className={importing ? "admin-spin" : undefined} />
                            {importing ? "更新中..." : "从原链接更新"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="admin-btn"
                          onClick={() => {
                            setScriptURL(form.scriptSourceUrl);
                            setReplacingScript(true);
                          }}
                        >
                          <Upload size={12} /> 替换脚本
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {showImportArea && (
              <div className="admin-crawler-import-box">
                <div
                  className={`admin-crawler-dropzone${dragOver ? " is-dragover" : ""}${importing ? " is-busy" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => !importing && fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (!importing) fileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                >
                  <Upload size={20} />
                  <strong>{importing ? "导入中..." : "上传 .py 脚本"}</strong>
                  <span>点击选择或拖拽到这里</span>
                </div>

                <div className="admin-crawler-link-import">
                  <label htmlFor="crawler-script-url">脚本链接</label>
                  <div className="admin-crawler-urlrow">
                    <input
                      id="crawler-script-url"
                      value={scriptURL}
                      onChange={(e) => setScriptURL(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          importURL();
                        }
                      }}
                      placeholder="https://example.com/crawler.py"
                      disabled={importing}
                    />
                    <button className="admin-btn" type="button" onClick={importURL} disabled={importing}>
                      <LinkIcon size={13} /> 链接导入
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="admin-crawler-editor__side">
            <section className="admin-crawler-panel">
              <header className="admin-crawler-panel__head">
                <span className="admin-crawler-panel__icon">
                  <TestTube size={15} />
                </span>
                <div>
                  <strong>测试脚本</strong>
                  <span>保存前验证抓取结果</span>
                </div>
              </header>
              <button className="admin-btn" type="button" onClick={test} disabled={!form.scriptPath || importing || testing}>
                <TestTube size={13} /> {testing ? "测试中..." : testResult ? "重新测试" : "运行测试"}
              </button>
              {testResult && <CrawlerTestResult result={testResult} />}
            </section>

            <section className="admin-crawler-panel">
              <header className="admin-crawler-panel__head">
                <span className="admin-crawler-panel__icon">
                  <Activity size={15} />
                </span>
                <div>
                  <strong>运行参数</strong>
                  <span>抓取数量、代理和上传目标</span>
                </div>
              </header>
              <div className="admin-crawler-params">
                <div className="admin-form__row">
                  <label htmlFor="crawler-target">每次新增视频数</label>
                  <input
                    id="crawler-target"
                    type="number"
                    min={1}
                    value={form.targetNew}
                    onChange={(e) => set("targetNew", e.target.value)}
                    placeholder="10"
                  />
                </div>
                <div className="admin-form__row">
                  <label htmlFor="crawler-proxy">代理地址</label>
                  <input
                    id="crawler-proxy"
                    value={form.proxy}
                    onChange={(e) => {
                      set("proxy", e.target.value);
                      setTestResult(null);
                    }}
                    placeholder="http://127.0.0.1:7890"
                  />
                </div>
                <CrawlerUploadTargetField
                  value={form.uploadDriveId}
                  onChange={(value) => set("uploadDriveId", value)}
                  uploadTargets={uploadTargets}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CrawlerEditorSummaryItem({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: "ok" | "error" | "info" | "muted";
  icon: ReactNode;
}) {
  return (
    <div className={`admin-crawler-editor-status is-${tone}`}>
      <span className="admin-crawler-editor-status__icon">{tone === "ok" ? <Check size={13} /> : icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CrawlerTestResult({ result }: { result: api.CrawlerDryRunResult }) {
  const item = result.items[0];
  const failure = crawlerTestFailure(result);
  const media = result.mediaCheck;

  return (
    <div className={`admin-crawler-test-result ${result.ok ? "is-ok" : "is-error"}`}>
      <div className="admin-crawler-test-result__head">
        <span className={`admin-status is-${result.ok ? "ok" : "error"}`}>{result.ok ? "测试通过" : "测试失败"}</span>
        <span>抓取到 {result.items.length} 条视频</span>
        {result.durationMs > 0 && <span>{Math.round(result.durationMs / 1000)} 秒</span>}
      </div>

      {failure && <div className="admin-crawler-test-result__error">{failure}</div>}

      {item && (
        <div className="admin-crawler-test-result__grid">
          <CrawlerTestField label="视频名" value={item.title} />
          <CrawlerTestField label="唯一标识" value={item.sourceId} />
          <CrawlerTestField label="视频直链" value={item.mediaUrl || item.mediaLocalFile} />
          <CrawlerTestField label="封面图" value={item.thumbnailUrl} />
          <CrawlerTestField label="详情页" value={item.detailUrl} />
        </div>
      )}

      {media && (
        <div className="admin-crawler-test-result__media">
          <span>直链校验</span>
          <strong>
            {media.ok ? "可访问" : "不可访问"}
            {media.status ? ` · HTTP ${media.status}` : ""}
            {media.contentType ? ` · ${media.contentType}` : ""}
            {media.contentLengthBytes ? ` · ${formatBytes(media.contentLengthBytes)}` : ""}
          </strong>
        </div>
      )}

      {result.log && result.log.length > 0 && (
        <details className="admin-crawler-test-result__log">
          <summary>脚本日志</summary>
          <pre>{result.log.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function CrawlerTestField({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined || value === "") return null;
  return (
    <div className="admin-crawler-test-result__field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function crawlerTestFailure(result: api.CrawlerDryRunResult) {
  return result.error || result.mediaCheck?.error || "";
}

function formatLastCrawl(ts?: number) {
  if (!ts) return "从未";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
