# 短信转发

这是基于 Cloudflare Workers、D1 和 Durable Objects 的短信事件转发服务，以及通过 WSS 接入的 LuatOS 设备客户端。服务端提供管理台、事件与短信历史、转发模板和规则、定时任务及远程短信命令。

> **硬件兼容范围：**当前项目记录的实机验证目标为 `LuatOS-SoC_V2056_Air780EPM_106`。其他 Air780 型号/固件尚未验证，不能据此认为即插即用兼容。BSP、短信事件、运营商功能及 TLS 行为需按实际型号和固件检查。

## 目录

- `server/` — Worker、管理台、D1 SQL 迁移和服务端测试。
- 根目录 Lua 文件 — 设备端开发源代码。
- `device/` — 与根源码同步的烧录目录；配置模板可公开，完成的个人配置不可公开。
- `tests/` — 模拟设备/网络的离线回归测试。

设备业务统一使用带 CA/主机名校验的 WSS。事件队列和命令日志保存在 RAM，断电或重启会丢失尚未完成的本地状态。短信有独立的有限命令 TTL、串行发送和会话/幂等保护；“已提交”不保证收件人收到，结果未知时不要盲目重发。

## 服务端：本地开发

需要 Node.js 22 或更新版本。先按 `server/wrangler.example.toml` 创建自己的本地 `server/wrangler.toml`，填写 Cloudflare 账户、D1 数据库 ID 和 rate-limit namespace ID；从变量模板创建仅本地使用的管理员密码和应用密钥：

```sh
cd server
npm ci
cp .dev.vars.example .dev.vars
cp wrangler.example.toml wrangler.toml
```

然后应用本地 SQL 迁移并运行开发 Worker：

```sh
npx wrangler d1 migrations apply air780-sms-relay-data --local
npm run dev
```

管理台默认位于 `http://127.0.0.1:8787/`，健康接口为 `/api/v1/health`。不要把真实密码、`APP_SECRET`、账户/数据库 ID 或个人部署配置提交到 GitHub。

完整服务端测试：

```sh
npm test
```

## 服务端：部署到自己的 Cloudflare 账户

在你自己的账户创建 D1 数据库并配置本地 `wrangler.toml`。管理员密码和至少 32 字符的随机 `APP_SECRET` 通过 Wrangler Secrets 设置：

```sh
cd server
npx wrangler d1 migrations apply air780-sms-relay-data --remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put APP_SECRET
npm run deploy
```

部署更新时保留现有 D1、Durable Object 迁移历史和 `APP_SECRET`。生产密钥不应写入 `wrangler.toml`、`.dev.vars` 或公开仓库。

## 设备配置与烧录

将 `device/config.example.lua` 复制为 `device/config.lua`，把 `SERVER_URL` 改为你自己的 Worker HTTPS 地址。将 `device/device_auth.lua.example` 复制为本地 `device/device_auth.lua`，填写规范化后的相同服务地址、实际模组 IMEI 或 SN，并给**每台设备单独**生成 32 字节随机 Base64URL 令牌：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

将同一台设备专用令牌填入该文件；不要复制其他设备的认证配置，也不要提交或分享填好的 `device_auth.lua`。烧录时选取 `device/` 目录内完整业务包。修改根目录共享 Lua 模块后同步到 `device/`，可运行离线测试确认副本一致。

为避免把通用名称误当成兼容保证，其他模块/固件需分别验证启动 API、BSP/引脚、SIM 与运营商短信能力、`SMS_SENT` 结果、WSS TLS/主机名校验及多段短信。软件模拟不代替目标设备测试。

## 离线测试

设备测试使用模拟 Lua 硬件，不会接触设备、固定认证或真实 SIM：

```sh
python -I -m pip install --target server/.wrangler/device-test-deps -r tests/requirements.txt
python -I tests/verify_device.py
python -I tests/verify_transport.py
```
