# 墨灵 MoLing

像聊天一样作图 —— 可接入任意绘图 API 的桌面端 AI 绘图工具。

墨灵是「绘图优先 + 任意 OpenAI 兼容 API + 桌面客户端」的 AI 绘图产品：填入任意服务商的 API 地址与 Key 即可开始作图，支持思考模型前置理解、参考图、上下文改图与局部重绘。

## 功能

- **聊天式文生图**：像发消息一样描述画面，逐轮生成、保留完整对话历史
- **思考模型（前置理解层）**：生成前先用大模型理解意图、扩写提示词；支持独立配置或复用绘图服务商，失败自动降级
- **参考图**：上传图片、拖入窗口或一键引用历史图片，随请求上送，多轮上下文改图（最多 4 张）
- **图像编辑**：局部重绘（涂抹蒙版）、AI 消除、扩图，结果自动回流对话
- **提示词助手**：场景模板库、灵感骰子、图片反推
- **服务商接入**：OpenAI 兼容接口 / 自定义占位符模板 / Mock 调试适配器；Key 本地 AES-256-GCM 加密存储
- **画廊**：生成记录、缩略图列表、按模型 / 风格 / 收藏筛选、复用参数、批量打包导出（含参数 JSON）
- **可取消生成**：停止按钮真正中止在途请求，已生成的图片保留
- **双主题**：浅色 / 暗色，跟随系统，全站过渡动画
- **数据备份**：配置与偏好一键导出/导入（默认不含明文 Key，可选包含；换机迁移）

## 快速开始（Windows）

### 一键启动 / 停止（推荐）

双击根目录的 **`start.bat`** 即可启动开发实例（后台执行 `pnpm tauri dev`，带热更新）；要关闭时双击 **`stop.bat`**。

- 首次启动会编译 Rust，通常 1~5 分钟；之后一般 10 秒内就绪。脚本会等待 `http://localhost:1420` 就绪再提示成功。
- 已在运行时再次双击 `start.bat` 只会提示「已在运行」，不会起第二份。
- 启动日志：`.run/moling-dev.log`；错误输出：`.run/moling-dev.err.log`；进程记录：`.run/moling.pid`。
- `stop.bat` 会结束启动进程树、清扫本仓库残留的 node/cargo/应用进程，并释放 1420 端口 —— 只处理属于本仓库的进程，不会误杀其它程序。
- 启动已打包版本：先 `pnpm tauri build --bundles nsis`，再双击 `start.bat -Release`。

### 命令行（等价）

```bash
pnpm install         # 首次
pnpm tauri dev       # 开发模式（热更新）
```

## 构建

```bash
pnpm tauri build --bundles nsis
# 产物：src-tauri/target/release/bundle/nsis/墨灵_*_x64-setup.exe
```

## 技术栈

Tauri 2（Rust）· React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · Zustand · SQLite（rusqlite）· framer-motion

平台：仅支持 **Windows**（密钥主密钥依赖 Windows 凭据管理器 DPAPI，见 `src-tauri/src/storage.rs`）。

## 测试与质量门禁

```bash
# 前端：类型检查 + ESLint + 格式检查 + 生产构建
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm build

# 后端：格式 + Clippy（零告警）+ 单元测试
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

CI（`.github/workflows/ci.yml`）在 Windows 上执行同一组门禁，并对生产依赖做 `pnpm audit --prod --audit-level high`。

## 目录结构

```
start.bat / stop.bat  一键启停入口（薄包装，逻辑在 scripts/）
scripts/              启停脚本（PowerShell 5.1）：前置检查、后台启动、pid/日志、进程树回收
src/                  React 前端（components / stores / lib）
src-tauri/src/        Rust 后端
  adapters/           适配器协议与实现（openai / template / mock / chat）
  commands/           Tauri 命令（mod / providers / settings / image / thinking / chat）
  storage.rs          SQLite 存储与 Key 加密（AES-256-GCM）
  image_store.rs      图片落盘、base64 富化与旧数据惰性迁移
  error.rs            统一错误类型与前端可解析的错误码
  paths.rs            应用数据目录解析
```

## 文档

- [产品功能文档](墨灵_产品功能文档.md)：功能清单、界面交互与里程碑状态
- [设计规范](墨灵_设计规范.md)：视觉语言、设计令牌、组件与交互基线（最高优先级）
- [开发规范](墨灵_开发规范.md)：架构、存储硬规则、ADR、编码规范、启停脚本契约、门禁、技术债与下一步计划

## 许可

[MIT](LICENSE)
