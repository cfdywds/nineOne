#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
光鸭网盘 - 扫码登录脚本
========================
1. 调用 API 获取登录二维码
2. 保存二维码图片，等待用户扫描
3. 扫描成功后保存用户凭证信息
"""

import io
import sys

# 修复 Windows 终端 GBK 编码问题
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import requests
import json
import time
import os
import sys
from datetime import datetime

# ========== 配置 ==========
API_ORIGIN = "https://account.guangyapan.com"
CLIENT_ID = "aMe-8VSlkrbQXpUR"
SCOPE = "user"
QR_IMAGE_PATH = "login_qr.png"
CREDENTIALS_PATH = "credentials.json"

# ========== 可选依赖 ==========
try:
    import qrcode
    HAS_QRCODE = True
except ImportError:
    HAS_QRCODE = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def generate_qr_image(url: str, path: str):
    """生成二维码图片"""
    if HAS_QRCODE:
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=4,
        )
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        img.save(path)
        print(f"[✓] 二维码已保存到: {path}")
    else:
        # Fallback: 使用 qrencode 命令行工具
        import subprocess
        try:
            subprocess.run(["qrencode", "-o", path, url], check=True)
            print(f"[✓] 二维码已保存到: {path}")
        except FileNotFoundError:
            print("[✗] 需要安装 qrcode 库: pip install qrcode[pil]")
            print(f"[!] 请手动访问以下链接扫码:")
            print(f"    {url}")
            return

    # 尝试直接显示二维码到终端
    try:
        if HAS_PIL:
            img = Image.open(path)
            img.show()
            print("[✓] 二维码已在图片查看器中打开")
    except Exception:
        pass

    # 终端内显示小二维码
    if HAS_QRCODE:
        try:
            qr.print_ascii(invert=True)
        except Exception:
            pass


def main():
    session = requests.Session()
    session.headers.update({
        "User-Agent": "GuangYaPan-Login/1.0",
        "Accept": "application/json",
        "Content-Type": "application/json",
    })

    # ====== Step 1: 获取设备码和二维码链接 ======
    print("=" * 60)
    print("Step 1: 请求登录二维码...")
    print("=" * 60)

    device_code_url = f"{API_ORIGIN}/v1/auth/device/code"
    device_payload = {
        "client_id": CLIENT_ID,
        "scope": SCOPE,
    }

    try:
        resp = session.post(device_code_url, json=device_payload, timeout=30)
        resp.raise_for_status()
        device_data = resp.json()
    except requests.exceptions.RequestException as e:
        print(f"[✗] 请求失败: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"    响应内容: {e.response.text[:500]}")
        sys.exit(1)

    print(f"[✓] 设备码获取成功")
    print(f"    device_code: {device_data.get('device_code', 'N/A')[:30]}...")
    print(f"    interval:    {device_data.get('interval', 5)} 秒")
    print(f"    expires_in:  {device_data.get('expires_in', 'N/A')} 秒")

    device_code = device_data["device_code"]
    interval = int(device_data.get("interval", 5))
    expires_in = int(device_data.get("expires_in", 300))

    # 二维码链接
    qr_url = device_data.get("verification_uri_complete") or device_data.get("short_uri_complete")
    if not qr_url:
        print("[✗] 响应中没有找到二维码链接")
        print(f"    完整响应: {json.dumps(device_data, indent=2, ensure_ascii=False)}")
        sys.exit(1)

    print(f"    qr_url:      {qr_url}")
    print()

    # ====== Step 2: 生成并保存二维码 ======
    print("=" * 60)
    print("Step 2: 生成二维码图片...")
    print("=" * 60)

    generate_qr_image(qr_url, QR_IMAGE_PATH)

    print()
    print("!" * 60)
    print("!  请使用「光鸭APP」扫描二维码登录")
    print("!" * 60)
    print()

    # ====== Step 3: 轮询等待用户扫描 ======
    print("=" * 60)
    print("Step 3: 等待扫码授权...")
    print("=" * 60)

    token_url = f"{API_ORIGIN}/v1/auth/token"
    token_payload = {
        "client_id": CLIENT_ID,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device_code,
    }

    start_time = time.time()
    attempt = 0

    while True:
        attempt += 1
        elapsed = time.time() - start_time

        # 检查是否超时
        if elapsed > expires_in:
            print(f"\n[✗] 二维码已过期（{expires_in}秒），请重新运行脚本")
            sys.exit(1)

        time.sleep(interval)

        try:
            resp = session.post(token_url, json=token_payload, timeout=30)
            token_data = resp.json()
        except requests.exceptions.RequestException as e:
            print(f"\n[!] 网络错误: {e}，重试中...")
            continue

        if "error" in token_data:
            error = token_data["error"]
            if error in ("authorization_pending", "slow_down"):
                # 用户还未扫描或确认
                dots = "." * ((attempt % 10) + 1)
                print(f"\r    等待中{dots:<10} ({int(elapsed)}s / {expires_in}s)", end="", flush=True)

                if error == "slow_down":
                    interval = min(interval * 2, 60)
                continue

            elif error == "expired_token":
                print(f"\n[✗] 二维码已过期，请重新运行脚本")
                sys.exit(1)

            elif error == "access_denied":
                print(f"\n[✗] 用户拒绝了授权")
                sys.exit(1)

            else:
                print(f"\n[✗] 未知错误: {error}")
                print(f"    完整响应: {json.dumps(token_data, indent=2, ensure_ascii=False)}")
                sys.exit(1)
        else:
            # 成功！
            print(f"\n[✓] 扫码授权成功！({int(elapsed)}s)")
            break

    # ====== Step 4: 保存凭证 ======
    print()
    print("=" * 60)
    print("Step 4: 保存用户凭证...")
    print("=" * 60)

    # 保存完整 token 响应
    credentials = {
        "saved_at": datetime.now().isoformat(),
        "api_origin": API_ORIGIN,
        "client_id": CLIENT_ID,
        "token_response": token_data,
        "cookies": dict(session.cookies),
    }

    with open(CREDENTIALS_PATH, "w", encoding="utf-8") as f:
        json.dump(credentials, f, indent=2, ensure_ascii=False)
    print(f"[✓] 完整凭证已保存到: {CREDENTIALS_PATH}")

    # 提取关键信息
    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token", "")
    id_token = token_data.get("id_token", "")
    token_type = token_data.get("token_type", "Bearer")
    expires_in = token_data.get("expires_in", 0)

    print()
    print("-" * 60)
    print("凭证摘要:")
    print("-" * 60)
    print(f"  access_token:   {access_token[:50]}..." if access_token else "  access_token:   (无)")
    print(f"  refresh_token:  {refresh_token[:50]}..." if refresh_token else "  refresh_token:  (无)")
    print(f"  id_token:       {id_token[:50]}..." if id_token else "  id_token:       (无)")
    print(f"  token_type:     {token_type}")
    print(f"  expires_in:     {expires_in} 秒")
    print(f"  scope:          {token_data.get('scope', SCOPE)}")
    print("-" * 60)

    # 尝试获取用户信息
    print()
    print("=" * 60)
    print("Step 5: 获取用户信息...")
    print("=" * 60)

    user_info_url = f"{API_ORIGIN}/v1/user/me"
    try:
        user_headers = {
            "Authorization": f"{token_type} {access_token}",
        }
        user_resp = requests.get(user_info_url, headers=user_headers, timeout=15)
        if user_resp.status_code == 200:
            user_data = user_resp.json()
            print("[✓] 用户信息获取成功:")
            print(json.dumps(user_data, indent=2, ensure_ascii=False))

            # 追加用户信息到凭证文件
            credentials["user_info"] = user_data
            with open(CREDENTIALS_PATH, "w", encoding="utf-8") as f:
                json.dump(credentials, f, indent=2, ensure_ascii=False)
        else:
            print(f"[!] 获取用户信息返回 {user_resp.status_code}: {user_resp.text[:200]}")
    except Exception as e:
        print(f"[!] 获取用户信息失败: {e}")

    print()
    print("=" * 60)
    print("完成！凭证文件: " + CREDENTIALS_PATH)
    print("=" * 60)


if __name__ == "__main__":
    main()
