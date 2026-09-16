# 探测器标定包安装器（山地天文台 · 隔离网络）

纯前端单页应用：在隔离网络中离线更新探测器标定包。浏览器可能在写入任一分块后
因供电切换被关闭；本应用以“逐块检查点 + 单事务激活”的协议保证半包永远不会被
当成当前版本。

## 技术栈

TypeScript · React · Vite · IndexedDB · Web Crypto · Vitest · Playwright · Docker。
不调用任何后端或在线服务。

## 数据与协议

- **清单（JSON）**：固定含 `version`、`payloadSize`、`sha256`、`chunkHashes`；
  所有散列均为 64 位小写十六进制 SHA-256。字段缺失、`payloadSize` 与
  `chunkHashes` 数量矛盾、散列格式错误都会得到明确反馈。
- **切块**：载荷按 1 048 576 字节（1 MiB）切块，末块取余，编号从 0 开始。
- **逐块检查点**：每块先验 SHA-256，通过后才以**独立事务**写入 IndexedDB
  （`chunks` 仓库）。
- **故障注入**：界面可设定“第 N 块提交后刷新页面”，模拟供电切换。
- **断点续作**：重开后旧激活版本保持可见；用户需重新选择清单与载荷文件；
  已暂存块复验通过即跳过，仅补写缺失或损坏块。续作清单的 `version`、
  `payloadSize`、`sha256` 任一不符即拒绝混用且不改写现场。
- **原子激活**：全部块就绪并组包、整包 SHA-256 通过后，才在一个事务内写入
  包记录、切换唯一 `active` 指针并清除暂存。
- **损坏报告**：载荷分块损坏按最小编号报告；重复安装同一版本不会产生第二份
  记录（`packages` 以 `version` 为主键）。

### IndexedDB 结构（`calibration-package-store`）

| 仓库       | 主键      | 内容                                   |
| ---------- | --------- | -------------------------------------- |
| `chunks`   | `index`   | 暂存分块检查点（独立事务逐块写入）     |
| `packages` | `version` | 已安装整包记录（按版本去重）           |
| `meta`     | `key`     | `staging` 暂存清单、`active` 激活指针  |

## 本地开发

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 类型检查 + 产物构建
npm run test       # Vitest（真实事务语义的 IndexedDB 实现 + Web Crypto）
npm run test:e2e   # Playwright（自动构建并预览，真实浏览器 IndexedDB 与页面刷新）
npm run verify     # 上述两者全量验收
```

## Docker

```bash
# 启动站点：宿主端口由 WEB_PORT 覆盖（默认 8080）
WEB_PORT=9000 docker compose up web
# 打开 http://localhost:9000

# 一次性验收服务：构建镜像并运行 Vitest + Playwright，跑完即退出
docker compose up verify            # 或：docker compose run --rm verify
```

`web` 服务为多阶段构建（Node 编译 → nginx 静态托管），`verify` 服务基于官方
Playwright 镜像，自带与 `@playwright/test` 版本匹配的 Chromium。

## 目录结构

```
src/lib/manifest.ts    清单解析与校验（切块规则、散列格式、大小矛盾）
src/lib/sha256.ts      Web Crypto SHA-256 与组包拼接
src/lib/db.ts          IndexedDB 持久层（检查点 / 包记录 / active 指针）
src/lib/installer.ts   崩溃可恢复安装引擎（复验、补写、原子激活、故障注入）
src/App.tsx            单页界面（文件选择、故障注入、进度与日志）
tests/unit/            Vitest：校验、散列、持久层、安装引擎全链路
tests/e2e/             Playwright：真实浏览器中的安装、断电刷新与续作
```
