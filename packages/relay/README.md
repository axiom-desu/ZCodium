# zcode-relay（用户自托管手机远控 relay）

ZCode 手机远控的**可选**跨网组件：桌面与手机都 outbound 连它，它只做鉴权、配对、心跳、
帧转发。**零业务状态、零持久化**——重启即全部失效，两端按重连流程恢复，不丢任何会话数据。

适用场景：手机和电脑不在同一网络。同网直连不需要它（桌面端默认行为，见
`../../.agents/specs/web-remote-control.md`）。

## 它做什么 / 不做什么

| 做                                           | 不做                     |
| -------------------------------------------- | ------------------------ |
| WebSocket 配对（注册 → 挑战鉴权 → 配对）     | 不存任务/会话/快照       |
| 双向帧转发（含体积上限与超限丢弃）           | 不做文件内容代理         |
| 单页面互踢（`KICKED`）、配对 TTL（默认 24h） | 不提供账号体系           |
| 托管移动端页面（`mobile.html` 静态目录）     | 不内置 TLS（用前置反代） |
| `/healthz` 健康检查、per-IP 限速             | 不收集任何遥测           |

## 快速开始

### 1. 构建

```bash
pnpm --filter @zcode/relay build      # 产出 packages/relay/dist/cli.mjs（单文件）
```

### 2. 准备移动端页面（可选但推荐）

relay 可以同时托管手机页面，省得你自己再找地方放：

```bash
pnpm --filter @zcode/web build        # 产出 packages/web/dist（含 mobile.html）
export ZCODE_RELAY_MOBILE_DIR=../web/dist
```

不设置 `ZCODE_RELAY_MOBILE_DIR` 时 relay 只转发 WS，页面返回 503；你可以把
`packages/web/dist` 放到任何静态托管上，然后在桌面端把端点地址指向它。

### 3. 运行

```bash
node packages/relay/dist/cli.mjs
# 默认 0.0.0.0:8443，WS 路径 /ws
```

### 4. Docker

```bash
docker build -t zcode-relay packages/relay
docker run -d --name zcode-relay -p 8443:8443 \
  -v "$(pwd)/packages/web/dist:/mobile:ro" \
  -e ZCODE_RELAY_MOBILE_DIR=/mobile \
  zcode-relay
```

### 5. TLS（强烈建议）

relay 本身只监听明文 WS。公网部署请用前置终结 TLS，任选其一：

- **Caddy**（自动证书）：

  ```caddyfile
  remote.example.com {
    reverse_proxy 127.0.0.1:8443
  }
  ```

- **cloudflared**（免公网端口）：`cloudflared tunnel --url http://127.0.0.1:8443`
- **traefik / nginx**：按你的既有配置反代到 `127.0.0.1:8443`，记得升级 WebSocket。

桌面端「远程控制 → 连接方式 → 我的端点」填 `wss://remote.example.com/ws`；
relay 托管的页面地址由桌面端自动推导（`wss` → `https`，根路径）。

## 配置

| 环境变量                      | 默认      | 说明                               |
| ----------------------------- | --------- | ---------------------------------- |
| `ZCODE_RELAY_PORT`            | `8443`    | 监听端口                           |
| `ZCODE_RELAY_HOST`            | `0.0.0.0` | 监听地址                           |
| `ZCODE_RELAY_PATH`            | `/ws`     | WebSocket 路径                     |
| `ZCODE_RELAY_MAX_FRAME_BYTES` | `1048576` | 单帧上限（1 MiB）                  |
| `ZCODE_RELAY_PAIR_TTL_HOURS`  | `24`      | 配对空闲 TTL                       |
| `ZCODE_RELAY_MOBILE_DIR`      | 空        | 移动端静态目录（含 `mobile.html`） |

## 协议

与桌面端共用 `@zcode/shared` 的 `webRemoteControl` 契约（`relayFrame.ts` /
`envelope.ts`），与官方 3.14.3 的 wire 兼容；扩展帧 `device_unregister` 见
`relayFrame.ts` 注释（刷新配对时桌面主动作废旧链接）。

## 安全基线

- 配对 secret 一次性：二维码链接里的 `hash` 即凭证，泄露 = 失效前可控制该工作区。
- 刷新二维码会作废旧链接（桌面发送 `device_unregister`，relay 立即删除配对）。
- 同一时刻只允许一个手机页面；第二个接入会把旧的踢掉。
- 日志只记 `deviceSid` 末 6 位，不记 secret/hash/proof。
- relay 无状态：不需要备份，也不需要信任它长期保存任何东西。

## 运维

- 看健康：`curl http://127.0.0.1:8443/healthz` → `{status, pairs, devices, mobiles}`
- 日志：JSON 行（stdout），可直接喂 journald / loki。
- 升级：直接替换二进制重启；对在线配对的影响 = 全部断开重连（业务无感）。
- 容量参考：2C/2G 机器可支撑 200+ 并发配对（转发为 KB/s 级文本帧）。
