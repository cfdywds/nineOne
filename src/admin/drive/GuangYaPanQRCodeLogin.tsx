import { useEffect, useState } from "react";
import { QrCode } from "lucide-react";
import * as api from "../api";
import { useToast } from "../ToastContext";

function guangYaPanQRStatusClass(
  status: api.GuangYaPanQRStatus | null,
  completed: boolean,
  error: string
): string {
  if (completed || status?.state === "success") return "is-ok";
  if (error || status?.state === "expired" || status?.state === "denied" || status?.state === "error")
    return "is-error";
  return "is-pending";
}

export function GuangYaPanQRCodeLogin({
  onCredentials,
}: {
  onCredentials: (credentials: {
    accessToken: string;
    refreshToken: string;
  }) => void;
}) {
  const { show } = useToast();
  const [session, setSession] = useState<api.GuangYaPanQRSession | null>(null);
  const [status, setStatus] = useState<api.GuangYaPanQRStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [pollingError, setPollingError] = useState("");
  const [completed, setCompleted] = useState(false);

  async function start() {
    setStarting(true);
    setPollingError("");
    setCompleted(false);
    setStatus(null);
    try {
      const next = await api.startGuangYaPanQRLogin();
      setSession(next);
    } catch (e) {
      setSession(null);
      show(e instanceof Error ? e.message : "生成二维码失败", "error");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!session || completed) return;
    const activeSession = session;
    let stopped = false;
    let timer: number | undefined;
    let delayMs = Math.max(1000, (activeSession.intervalSeconds || 5) * 1000);

    async function poll() {
      if (stopped) return;
      try {
        const next = await api.getGuangYaPanQRStatus(activeSession.deviceCode);
        if (stopped) return;
        setStatus(next);
        setPollingError("");
        if (next.intervalSeconds && next.intervalSeconds > 0) {
          delayMs = Math.max(1000, next.intervalSeconds * 1000);
        }
        if (next.accessToken && next.refreshToken) {
          stopped = true;
          if (timer) window.clearTimeout(timer);
          setCompleted(true);
          onCredentials({
            accessToken: next.accessToken,
            refreshToken: next.refreshToken,
          });
          show("扫码成功，已填入 access_token 和 refresh_token，保存后生效", "success");
          return;
        }
        if (next.state === "expired" || next.state === "denied" || next.state === "error") {
          stopped = true;
          if (timer) window.clearTimeout(timer);
          return;
        }
      } catch (e) {
        if (stopped) return;
        setPollingError(e instanceof Error ? e.message : "查询扫码状态失败");
      }
      if (!stopped) {
        timer = window.setTimeout(poll, delayMs);
      }
    }

    poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [session, completed, onCredentials, show]);

  const statusText = completed
    ? "已获取凭证"
    : pollingError || status?.statusText || (session ? "等待扫码" : "未生成二维码");
  const statusClass = guangYaPanQRStatusClass(status, completed, pollingError);

  return (
    <div className="admin-form__row">
      <label>扫码登录</label>
      <div className="admin-p123-qr">
        <div className="admin-p123-qr__actions">
          <button
            type="button"
            className="admin-btn"
            onClick={start}
            disabled={starting}
          >
            <QrCode size={14} />
            {starting ? "生成中..." : session ? "重新生成二维码" : "生成二维码"}
          </button>
          <span className={`admin-status ${statusClass}`}>{statusText}</span>
        </div>

        {session && (
          <div className="admin-p123-qr__body">
            <img
              className="admin-p123-qr__image"
              src={session.qrImageDataUrl}
              alt="光鸭网盘扫码登录二维码"
            />
            <div className="admin-p123-qr__meta">
              <div className="admin-form__help">
                使用光鸭 App 扫码并确认登录；确认后系统会自动填入 access_token 和 refresh_token。
              </div>
              {session.expiresAt && (
                <div className="admin-form__help">
                  过期时间：{new Date(session.expiresAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
              )}
              {(status?.state === "expired" || status?.state === "denied") && (
                <div className="admin-form__help">
                  当前二维码{status.state === "denied" ? "已被拒绝" : "已过期"}，请重新生成。
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
