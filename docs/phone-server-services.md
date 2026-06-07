# 手机服务器服务访问文档

最后检查时间：2026-06-06 17:56 Asia/Shanghai

## 概览

手机设备信息：

- 型号：OnePlus A6000
- ADB 设备 ID：`506dcd14`
- Ubuntu chroot 路径：`/data/local/chroot-distro/ubuntu`
- 主服务管理器：`supervisor`
- Tailscale 节点名：`phone-server`
- Tailscale IP：`100.105.203.2`
- Tailscale DNS 名称：`phone-server.tailbf8fb3.ts.net`

## 公网访问

当前公网 HTTPS 入口：

- grok2api 固定域名：`https://grok.obxunil.eu.cc/docs`
- Resin 固定域名：`https://resin.obxunil.eu.cc/ui/`
- cf-vps-monitor 探针面板：`https://monitor.obxunil.eu.cc`
- grok2api 后端转发目标：`http://127.0.0.1:8000`
- Resin 后端转发目标：`http://127.0.0.1:10080`
- 固定域名管理方式：`cloudflared-grok2api-named`，Cloudflare Named Tunnel，由 `supervisor` 托管
- 临时域名管理方式：`cloudflared-grok2api`，Cloudflare Quick Tunnel，由 `supervisor` 托管

`monitor.obxunil.eu.cc` 不是转发到手机本地端口的 Cloudflare Tunnel，而是 Cloudflare Worker 自身的自定义域名，用于访问 `cf-vps-monitor` 面板。

固定域名入口使用 Cloudflare Named Tunnel，域名不会随 `cloudflared` 重启变化。Named Tunnel 当前用同一个隧道按 `hostname` 分流：

```yaml
ingress:
  - hostname: resin.obxunil.eu.cc
    service: http://127.0.0.1:10080
  - hostname: grok.obxunil.eu.cc
    service: http://127.0.0.1:8000
  - service: http_status:404
```

配置文件路径：

```text
/data/local/chroot-distro/ubuntu/etc/cloudflared/grok2api-named.yml
```

最后一条 `http_status:404` 是兜底规则，所有具体 `hostname` 规则都必须放在它前面。Quick Tunnel 入口保留为临时回退入口，它可以立即提供公网访问，但域名是临时随机域名，`cloudflared` 重启后可能变化。查看当前公网地址：

```bash
phone-server-status
```

## 常用访问地址

grok2api：

- 公网固定文档页：`https://grok.obxunil.eu.cc/docs`
- Tailscale 内网文档页：`http://phone-server.tailbf8fb3.ts.net:8000/docs`
- 公网临时文档页：以 `phone-server-status` 当前输出为准

Resin：

- 公网固定管理 UI：`https://resin.obxunil.eu.cc/ui/`
- 管理 UI：`http://phone-server.tailbf8fb3.ts.net:18080/ui/`
- HTTP proxy：`http://phone-server.tailbf8fb3.ts.net:10080`

注意：Tailscale 内网的 `10080` 是 Resin 的 HTTP 代理端口，Chrome 会拦截浏览器直接访问并显示 `ERR_UNSAFE_PORT`；浏览器打开 Resin 管理 UI 时，内网使用 `18080`，公网使用 `https://resin.obxunil.eu.cc/ui/`。

cf-vps-monitor：

- 探针面板：`https://monitor.obxunil.eu.cc`
- 登录页：`https://monitor.obxunil.eu.cc/login.html`
- 管理员用户名：`phoneadmin`
- 管理员密码：`T42YAGtsAiQuBj4pPPD1Rx4y`
- Agent API key 等部署密钥保存在本机部署记录：`temp/cf-vps-monitor-deployment.json`

## cf-vps-monitor 探针

本探针基于开源项目 `https://github.com/kadidalax/cf-vps-monitor` 部署，面板运行在 Cloudflare Worker + D1 上，手机侧 Ubuntu chroot 内运行 Agent 上报主机指标。

### Cloudflare 侧

| 项目 | 值 |
| --- | --- |
| 面板域名 | `https://monitor.obxunil.eu.cc` |
| Worker 名称 | `cf-vps-monitor-phone-server` |
| Worker workers.dev 地址 | `https://cf-vps-monitor-phone-server.wanghaijuntly.workers.dev` |
| D1 数据库 | `cf-vps-monitor-phone-server-db` |
| D1 数据库 ID | `95ed6316-728f-4138-8654-60584323f2e1` |
| 定时触发器 | `0 * * * *`，每小时执行网站检测 |
| 管理员用户名 | `phoneadmin` |
| 管理员密码 | `T42YAGtsAiQuBj4pPPD1Rx4y` |

当前面板内的主机条目：

| 字段 | 值 |
| --- | --- |
| 服务器名称 | `phone-server.tailbf8fb3.ts.net` |
| Server ID | `fhmdjg` |
| Agent API key | 见 `temp/cf-vps-monitor-deployment.json` 和手机侧 `/root/.cf-vps-monitor/config/config` |

当前面板内的网站检测项：

| 名称 | URL | 说明 |
| --- | --- | --- |
| `phone-server Resin UI` | `https://resin.obxunil.eu.cc/ui/` | 检测 Resin 公网管理 UI |
| `phone-server grok2api docs` | `https://grok.obxunil.eu.cc/docs` | 检测 grok2api 公网文档页 |

`phone-server.tailbf8fb3.ts.net` 是 Tailscale 内网名称，Cloudflare Worker 侧无法从公网 DNS 直接解析它；因此面板的网站检测使用公网 Cloudflare Named Tunnel 域名，主机 CPU/内存/磁盘/网络指标由手机本地 Agent 主动上报。

### 手机侧 Agent

Agent 安装在 Ubuntu chroot 的 root 用户目录下：

| 路径 | 用途 |
| --- | --- |
| `/root/.cf-vps-monitor` | Agent 主目录 |
| `/root/.cf-vps-monitor/config/config` | Worker URL、Server ID、Agent API key 和上报间隔 |
| `/root/.cf-vps-monitor/bin/vps-monitor-service.sh` | Agent 服务脚本 |
| `/root/.cf-vps-monitor/logs/monitor.log` | Agent 上报日志 |
| `/root/.cf-vps-monitor/logs/supervisor.out.log` | supervisor stdout 日志 |
| `/root/.cf-vps-monitor/logs/supervisor.err.log` | supervisor stderr 日志 |
| `/tmp/cf-vps-monitor.sh` | 安装时复制的上游管理脚本 |

当前由 Ubuntu chroot 内的 `supervisor` 托管：

```text
program: cf-vps-monitor
command: /root/.cf-vps-monitor/bin/vps-monitor-service.sh
```

常用运维命令：

```powershell
# 查看 Agent supervisor 状态
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl status cf-vps-monitor"

# 重启 Agent
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart cf-vps-monitor"

# 查看 Agent 上报日志
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /bin/bash -lc 'tail -50 /root/.cf-vps-monitor/logs/monitor.log'"

# 查看脱敏后的 Agent 配置
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /bin/bash -lc 'sed -E \"s/^(API_KEY=\\\").{8}.*(\\\")$/\\1[REDACTED]\\2/\" /root/.cf-vps-monitor/config/config'"
```

面板侧验证命令：

```powershell
curl.exe -sS --max-time 30 https://monitor.obxunil.eu.cc/api/status/batch
```

预期能看到 `phone-server.tailbf8fb3.ts.net`，并且 `metrics.error` 为 `false`，`cpu`、`memory`、`disk` 等字段有数值。

## Resin 凭证和修改方式

Resin 当前不是传统“账号 + 密码”体系，而是通过 token 鉴权。

| 用途 | 地址 | 用户名 | 密码/token |
| --- | --- | --- | --- |
| Resin 管理 UI | `https://resin.obxunil.eu.cc/ui/` 或 `http://phone-server.tailbf8fb3.ts.net:18080/ui/` | 无 | `RESIN_ADMIN_TOKEN` |
| Resin HTTP 代理 | `http://phone-server.tailbf8fb3.ts.net:10080` | `Default` | `RESIN_PROXY_TOKEN` |

`RESIN_ADMIN_TOKEN` 只用于登录 Resin 管理 UI；`RESIN_PROXY_TOKEN` 才是提供给其他服务作为 HTTP proxy 密码使用的值。不要把管理 token 给普通服务调用。

Resin V1 会解析 HTTP proxy 的用户名，当前平台名是 `Default`。如果使用 `resin:<RESIN_PROXY_TOKEN>`，鉴权 token 虽然正确，但用户名 `resin` 没有对应平台，会返回 `X-Resin-Error: PLATFORM_NOT_FOUND`。

### 给其他服务调用 Resin HTTP 代理

给其他服务配置 Resin 时，使用 Tailscale 内网代理地址：

```text
代理类型：HTTP
代理地址：phone-server.tailbf8fb3.ts.net
代理端口：10080
用户名：Default
密码：RESIN_PROXY_TOKEN
```

也可以使用 Tailscale IP：

```text
http://100.105.203.2:10080
```

不要把 `https://resin.obxunil.eu.cc/ui/` 配成 HTTP forward proxy。这个公网域名只适合访问 Resin 管理 UI；Cloudflare Tunnel 不适合承载 Resin 的 `CONNECT` 代理流量。

Linux/macOS 服务环境变量示例：

```bash
export HTTP_PROXY='http://Default:<RESIN_PROXY_TOKEN>@phone-server.tailbf8fb3.ts.net:10080'
export HTTPS_PROXY='http://Default:<RESIN_PROXY_TOKEN>@phone-server.tailbf8fb3.ts.net:10080'
export NO_PROXY='127.0.0.1,localhost,100.64.0.0/10'
```

PowerShell 当前窗口环境变量示例：

```powershell
$env:HTTP_PROXY = "http://Default:<RESIN_PROXY_TOKEN>@phone-server.tailbf8fb3.ts.net:10080"
$env:HTTPS_PROXY = "http://Default:<RESIN_PROXY_TOKEN>@phone-server.tailbf8fb3.ts.net:10080"
$env:NO_PROXY = "127.0.0.1,localhost,100.64.0.0/10"
```

如果客户端支持单独填写代理用户名和密码，优先分开填写，避免 token 中的特殊字符需要 URL 编码：

```text
proxy_host = phone-server.tailbf8fb3.ts.net
proxy_port = 10080
proxy_username = Default
proxy_password = <RESIN_PROXY_TOKEN>
```

`curl` 调用示例：

```powershell
curl.exe --max-time 15 -x http://phone-server.tailbf8fb3.ts.net:10080 --proxy-user "Default:<RESIN_PROXY_TOKEN>" -I https://linux.do/
```

预期先看到：

```text
HTTP/1.1 200 Connection Established
```

如果返回 `X-Resin-Error: PLATFORM_NOT_FOUND`，优先检查代理用户名是否写成了 `Default`。如果返回 `407 Proxy Authentication Required`，说明代理端口可达，但 `RESIN_PROXY_TOKEN` 没有带上或填错了。

### 获取 Resin 密码/token

从电脑通过 ADB 查看当前 Resin token：

```powershell
adb shell su -c "grep '^RESIN_ADMIN_TOKEN=' /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env"
adb shell su -c "grep '^RESIN_PROXY_TOKEN=' /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env"
```

只想确认两个 token 是否相同、但不打印原文时，查看哈希：

```powershell
adb shell su -c "grep '^RESIN_ADMIN_TOKEN=' /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env | cut -d= -f2- | sha256sum"
adb shell su -c "grep '^RESIN_PROXY_TOKEN=' /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env | cut -d= -f2- | sha256sum"
```

HTTP 代理客户端配置示例：

```bash
HTTP_PROXY=http://Default:<RESIN_PROXY_TOKEN>@phone-server.tailbf8fb3.ts.net:10080
HTTPS_PROXY=http://Default:<RESIN_PROXY_TOKEN>@phone-server.tailbf8fb3.ts.net:10080
```

`curl` 验证示例：

```bash
curl -x http://phone-server.tailbf8fb3.ts.net:10080 \
  --proxy-user 'Default:<RESIN_PROXY_TOKEN>' \
  https://example.com
```

### 修改 Resin 管理密码或代理密码

修改前先生成新的随机 token。建议使用只包含十六进制字符的 token，避免 shell、URL 或配置文件转义问题：

```powershell
openssl rand -hex 16
```

修改前备份 Resin 配置：

```powershell
adb shell su -c 'cp /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env.bak_$(date +%Y%m%d_%H%M%S)'
```

修改管理 UI 登录 token：

```powershell
adb shell su -c 'sed -i "s/^RESIN_ADMIN_TOKEN=.*/RESIN_ADMIN_TOKEN=<NEW_ADMIN_TOKEN>/" /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env'
```

修改 HTTP 代理 token：

```powershell
adb shell su -c 'sed -i "s/^RESIN_PROXY_TOKEN=.*/RESIN_PROXY_TOKEN=<NEW_PROXY_TOKEN>/" /data/local/chroot-distro/ubuntu/home/cfdywds/Resin/.env'
```

当前 Resin 的历史 supervisor 配置里也曾写入过 `RESIN_ADMIN_TOKEN` 和 `RESIN_PROXY_TOKEN`。如果 `/data/local/chroot-distro/ubuntu/etc/supervisor/conf.d/resin.conf*` 中存在 `environment=` 行，需要同步更新里面的 token，或者改成只从 `/home/cfdywds/Resin/.env` 加载，避免重启后又用回旧值。先检查：

```powershell
adb shell su -c "grep -n 'RESIN_.*TOKEN' /data/local/chroot-distro/ubuntu/etc/supervisor/conf.d/resin.conf*"
```

如果只改了 `RESIN_PROXY_TOKEN`，还要同步更新所有使用 Resin 代理的服务配置。当前已知 grok2api 会使用 Resin 代理，配置文件是：

```text
/data/local/chroot-distro/ubuntu/home/cfdywds/grok2api/data/config.toml
```

修改完成后重启 Resin；如果改了 grok2api 的代理 token，也重启 grok2api：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart resin"
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart grok2api"
```

验证：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl status resin grok2api"
curl.exe -I --max-time 8 http://phone-server.tailbf8fb3.ts.net:18080/ui/
curl.exe -I --max-time 8 -x http://phone-server.tailbf8fb3.ts.net:10080 http://archive.ubuntu.com/ubuntu/
```

未带代理 token 的 HTTP proxy 请求返回 `407 Proxy Authentication Required` 是正常结果，表示代理端口可达且鉴权生效。

## Tailscale 内网访问

以下地址仅限 Tailscale tailnet 内访问。Resin 的本地服务端口是 `10080`；Chrome 会把 `10080` 判定为不安全端口并显示 `ERR_UNSAFE_PORT`，所以浏览器访问管理 UI 使用 Tailscale Serve 的安全端口别名 `18080`。代理客户端继续使用 HTTP proxy 地址，不要使用 `tcp://` 作为浏览器或代理配置的 URL。

| 服务 | Tailnet 地址 | 转发目标 |
| --- | --- | --- |
| grok2api 文档页 | `http://phone-server.tailbf8fb3.ts.net:8000/docs` | `127.0.0.1:8000` |
| Resin 管理 UI | `http://phone-server.tailbf8fb3.ts.net:18080/ui/` | `127.0.0.1:10080` |
| Resin HTTP 代理 | `http://phone-server.tailbf8fb3.ts.net:10080` | `127.0.0.1:10080` |
| SSH | `phone-server.tailbf8fb3.ts.net:2222` | `127.0.0.1:22` |

也可以直接使用 Tailscale IP：

- `http://100.105.203.2:8000/docs`
- `http://100.105.203.2:18080/ui/`
- `http://100.105.203.2:10080`（HTTP proxy 地址）
- `100.105.203.2:2222`

## 本地端口

| 端口 | 进程 | 用途 | 暴露范围 |
| --- | --- | --- | --- |
| `8000` | `python3` / grok2api | grok2api API 和文档页 | 通过 Cloudflare Named Tunnel 和 Quick Tunnel 公网访问；通过 Tailscale 内网访问 |
| `10080` | `resin` | Resin HTTP 代理和管理 UI 后端 | 通过 Cloudflare Named Tunnel 公网访问管理 UI；通过 Tailscale 内网访问 |
| `2222` | `sshd` | SSH 访问 | 仅 Tailscale 内网 |
| `9090` | `cockpit-ws` | Cockpit Web UI | 手机本地监听；当前未通过 Tailscale Serve 暴露 |
| `20241` | `cloudflared` | cloudflared metrics | 仅 localhost |

## Supervisor 服务

当前 `supervisor` 管理的程序：

| 程序 | 用途 |
| --- | --- |
| `grok2api` | API 服务，监听 `8000` |
| `resin` | 代理服务，监听 `10080` |
| `cockpit-ws` | Cockpit Web UI，监听 `9090` |
| `cloudflared-grok2api-named` | Cloudflare Named Tunnel，按域名把 `https://grok.obxunil.eu.cc` 转发到 grok2api，把 `https://resin.obxunil.eu.cc` 转发到 Resin |
| `cloudflared-grok2api` | Cloudflare Quick Tunnel，把公网 HTTPS 转发到 grok2api |
| `cf-vps-monitor` | cf-vps-monitor Agent，定期向 `https://monitor.obxunil.eu.cc` 上报 phone-server 主机指标 |

从电脑通过 ADB 执行的常用命令：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl status"
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart grok2api"
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart resin"
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart cf-vps-monitor"
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart cloudflared-grok2api-named"
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart cloudflared-grok2api"
```

在 Ubuntu chroot 内执行：

```bash
supervisorctl status
phone-server-status
```

## Cloudflare Named Tunnel 运维

Named Tunnel 配置文件：

```text
/data/local/chroot-distro/ubuntu/etc/cloudflared/grok2api-named.yml
```

当前隧道 ID：

```text
00565ccf-d622-42a3-983a-1d072a108ab1
```

当前固定域名映射：

| 域名 | 后端服务 | 说明 |
| --- | --- | --- |
| `grok.obxunil.eu.cc` | `http://127.0.0.1:8000` | grok2api |
| `resin.obxunil.eu.cc` | `http://127.0.0.1:10080` | Resin 管理 UI 和 Resin HTTP 服务入口 |

### 本次 Resin 域名接入记录

本次新增 `resin.obxunil.eu.cc` 时执行过的关键步骤如下。

先备份现有 tunnel 配置：

```powershell
adb shell su -c "cp /data/local/chroot-distro/ubuntu/etc/cloudflared/grok2api-named.yml /data/local/chroot-distro/ubuntu/etc/cloudflared/grok2api-named.yml.bak_resin_20260606_1418"
```

然后在 `ingress` 里新增 Resin 规则，并保留原 grok2api 规则：

```yaml
ingress:
  - hostname: resin.obxunil.eu.cc
    service: http://127.0.0.1:10080
  - hostname: grok.obxunil.eu.cc
    service: http://127.0.0.1:8000
  - service: http_status:404
```

校验配置：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/local/bin/cloudflared tunnel --config /etc/cloudflared/grok2api-named.yml ingress validate"
```

预期输出包含：

```text
Validating rules from /etc/cloudflared/grok2api-named.yml
OK
```

创建 Cloudflare DNS 路由：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/local/bin/cloudflared tunnel --config /etc/cloudflared/grok2api-named.yml route dns 00565ccf-d622-42a3-983a-1d072a108ab1 resin.obxunil.eu.cc"
```

预期输出类似：

```text
Added CNAME resin.obxunil.eu.cc which will route to this tunnel
```

重启 named tunnel：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart cloudflared-grok2api-named"
```

验证服务状态和两个固定域名：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl status cloudflared-grok2api-named resin grok2api"
curl.exe -I https://resin.obxunil.eu.cc/ui/
curl.exe -I https://grok.obxunil.eu.cc
```

2026-06-06 14:29 的验证结果：

- `cloudflared-grok2api-named`、`resin`、`grok2api` 都是 `RUNNING`
- `https://resin.obxunil.eu.cc/ui/` 返回 `HTTP/1.1 200 OK`
- `https://grok.obxunil.eu.cc` 返回 `HTTP/1.1 405 Method Not Allowed`，与原服务行为一致，说明 grok2api 仍走 `127.0.0.1:8000`

### 新增其他公网服务

以后新增服务时，按“一服务一域名，一条 ingress 规则”的方式接入同一个 named tunnel。

1. 确认服务监听地址和端口，例如 `127.0.0.1:9000` 或 `0.0.0.0:9000`。
2. 备份 `/data/local/chroot-distro/ubuntu/etc/cloudflared/grok2api-named.yml`。
3. 在 `ingress` 里新增域名规则，必须放在 `- service: http_status:404` 前面。
4. 执行 `cloudflared tunnel --config /etc/cloudflared/grok2api-named.yml ingress validate`。
5. 执行 `cloudflared tunnel --config /etc/cloudflared/grok2api-named.yml route dns 00565ccf-d622-42a3-983a-1d072a108ab1 新服务.obxunil.eu.cc`。
6. 重启 `cloudflared-grok2api-named`。
7. 同时验证新域名和已有域名，避免误改现有服务。

新增服务示例：

```yaml
ingress:
  - hostname: new-service.obxunil.eu.cc
    service: http://127.0.0.1:9000
  - hostname: resin.obxunil.eu.cc
    service: http://127.0.0.1:10080
  - hostname: grok.obxunil.eu.cc
    service: http://127.0.0.1:8000
  - service: http_status:404
```

只重启 `cloudflared-grok2api-named` 通常会让所有固定域名短暂中断几秒，但不会重启后端服务本身。不要修改 `grok.obxunil.eu.cc` 的 `service` 值，除非明确要迁移 grok2api 后端。

## 代理链路

grok2api 已配置为通过 Resin 出口代理访问外网：

- grok2api 代理模式：`single_proxy`
- 代理目标：`http://127.0.0.1:10080`
- Resin 代理 token 保存在 grok2api 配置文件中，不要打印、截图或提交到仓库。

修改 `/home/cfdywds/grok2api/data/config.toml` 后需要重启 `grok2api` 才会生效：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /usr/bin/supervisorctl restart grok2api"
```

如果只是调整 Resin 自己的节点、出口或策略，并且 grok2api 的代理地址和 token 不变，通常不需要重启 `grok2api`。

验证命令：

```powershell
adb shell su -c "chroot /data/local/chroot-distro/ubuntu /bin/bash /tmp/resin_proxy_verify.sh"
```

预期结果：

- `archive.ubuntu.com` 返回 `HTTP/2 200`
- `grok.com` 能通过 Resin 返回 HTTP 响应

从电脑侧验证 Resin 是否可访问：

```powershell
curl.exe -I --max-time 8 http://phone-server.tailbf8fb3.ts.net:10080/ui/
curl.exe -I --max-time 8 http://phone-server.tailbf8fb3.ts.net:18080/ui/
curl.exe -I --max-time 8 -x http://phone-server.tailbf8fb3.ts.net:10080 http://archive.ubuntu.com/ubuntu/
curl.exe --max-time 15 -x http://phone-server.tailbf8fb3.ts.net:10080 --proxy-user "Default:<RESIN_PROXY_TOKEN>" -I https://linux.do/
```

预期结果：

- `10080/ui/` 在 curl 中返回 `HTTP/1.1 200 OK`，但 Chrome 会拦截该端口并显示 `ERR_UNSAFE_PORT`。
- `18080/ui/` 在 curl 和浏览器中都应返回 Resin 管理 UI。
- 未带代理 token 的 HTTP proxy 请求返回 `HTTP/1.1 407 Proxy Authentication Required` 和 `X-Resin-Error: AUTH_REQUIRED`，这表示 Resin 代理端口可达且鉴权生效。
- 带 `Default:<RESIN_PROXY_TOKEN>` 的 HTTPS 代理请求应先返回 `HTTP/1.1 200 Connection Established`，随后才是目标站点自己的 HTTP 响应。
- 如果使用 `resin:<RESIN_PROXY_TOKEN>` 并返回 `X-Resin-Error: PLATFORM_NOT_FOUND`，说明用户名没有对应 Resin 平台；当前应使用 `Default`。
- 未带管理 token 访问 Resin API 返回 `401 Unauthorized` 是正常保护行为。

## Tailscale 说明

Tailscale 运行在 chroot 外侧，但使用 Ubuntu 里的二进制：

```text
/data/local/chroot-distro/ubuntu/usr/sbin/tailscaled
```

Tailscale CLI 需要从 Android root 环境执行，不要在 chroot 内直接调用，因为 socket 路径是 Android 根路径：

```powershell
adb shell su -c "/data/local/chroot-distro/ubuntu/usr/bin/tailscale --socket=/data/local/tmp/tailscale/tailscaled.sock status"
adb shell su -c "/data/local/chroot-distro/ubuntu/usr/bin/tailscale --socket=/data/local/tmp/tailscale/tailscaled.sock serve status"
```

如果 `18080` 还未生效，可在手机通过 ADB 配置浏览器安全端口别名：

```powershell
adb push temp\repair_tailscale_autostart.sh /data/local/tmp/repair_tailscale_autostart.sh
adb shell su -c "sh /data/local/tmp/repair_tailscale_autostart.sh"
adb shell su -c "/data/local/chroot-distro/ubuntu/usr/bin/tailscale --socket=/data/local/tmp/tailscale/tailscaled.sock serve --bg --tcp=18080 tcp://127.0.0.1:10080"
```

已经测试过 Tailscale Funnel。当前 tailnet 没有启用 Funnel，CLI 明确提示需要先到 Tailscale 管理后台启用，之后才能用于公网访问。

## 安全注意事项

- Resin 管理 UI 当前已通过 Cloudflare Named Tunnel 暴露到公网：`https://resin.obxunil.eu.cc/ui/`。必须保持 Resin 管理鉴权开启。
- 不要把 Resin HTTP 代理能力或 SSH 直接暴露到公网，除非明确需要并且有额外鉴权或访问控制。
- SSH 当前应保持 Tailscale 内网访问。
- 不要打印或提交以下文件里的 token：
  - `/home/cfdywds/Resin/.env`
  - `/home/cfdywds/grok2api/data/config.toml`
  - `/root/.cf-vps-monitor/config/config`
  - `temp/cf-vps-monitor-deployment.json`
- `/home/cfdywds/Resin/deploy_and_start.sh` 是历史部署脚本，里面可能包含旧 token 或重写 `.env` 的逻辑；重新运行前必须先检查并更新其中的 `RESIN_ADMIN_TOKEN` 和 `RESIN_PROXY_TOKEN`。
- Cloudflare Named Tunnel 当前会把 grok2api 和 Resin 管理 UI 暴露到公网。需要确保 grok2api API 鉴权和 Resin 管理鉴权保持开启。
- cf-vps-monitor 面板已通过 Cloudflare Worker 自定义域名 `https://monitor.obxunil.eu.cc` 暴露到公网；需要保持管理员密码和 Agent API key 保密。
