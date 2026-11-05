# 墨灵 MoLing

像聊天一样作图 —— 可接入任意绘图 API 的桌面端 AI 绘图工具。

墨灵是「绘图优先 + 任意 OpenAI 兼容 API + 桌面客户端」的 AI 绘图产品：填入任意服务商的 API 地址与 Key 即可开始作图，支持原文直达生成、参考图、多轮上下文改图、局部重绘，以及把作品编排到无限画布的工作区。

## 功能

- **聊天式文生图**：像发消息一样描述画面，逐轮生成、保留完整对话历史
- **原文直达**：不做前置改写，用户原话连同参考图一起交给绘图模型；参考图未占满上限时自动带上上一轮画面，让决定画面的模型自己理解追问（思考模型仍用于提示词助手的翻译、反推与优化，以及会话标题）
- **AI 会话标题**：新会话首条消息后由文本模型自动命名并在侧栏即时更新；与提示词优化同属「设置 → 生成 → AI 助手」，可分别开关
- **参考图**：上传图片、拖入窗口或输入坞、一键引用历史图片，随请求上送，多轮上下文改图（最多 4 张）；长边 >2048 或 >4MB 自动压缩，缩略图角标提示「已压缩」；可分角色（构图 / 风格 / 人脸 / 元素）与强度
- **逐张进度**：批量生成时气泡实时显示「正在绘制 · i/n」，不再只有一个骨架屏
- **图像编辑**：局部重绘（涂抹蒙版）、AI 消除、扩图、换背景（纯色 / 渐变本地合成 / AI 描述）、基础编辑（裁剪 / 旋转 / 翻转 / 亮度对比度饱和度，纯本地），结果自动回流对话
- **图像变换**：2x / 4x 高清放大、风格转换（走服务商 API）
- **提示词助手**：场景模板库、灵感骰子、图片反推、中英互译、AI 优化（补全场景 / 构图 / 光线 / 质感，一键填入）、收藏（标签 / 过滤 / 导入导出）、工作流预设（提示词 + 参数 + 参考图，可导出分享）
- **画布工作区**：把画廊作品放到无限画布上，拖拽排布、滚轮缩放、背景平移、节点连线；任一节点可进入全部编辑能力，结果回画廊后可再加入画布；多画布自动保存
- **服务商接入**：OpenAI 兼容接口 / 自定义占位符模板 / Mock 调试适配器；Key 本地 AES-256-GCM 加密存储
- **多 Key 与代理**：单个服务商可挂多个 Key，401 自动切换并标记失效（403 只切换）；代理支持跟随系统 / 直连 / 手动，切换无需重启
- **画廊**：生成记录、按天时间线、等比 justified 布局（完整显示、不裁切）、按模型 / 风格 / 收藏筛选、两两对比（滑动叠图 / 并排）、复用参数、批量打包导出（含参数 JSON）；下载 / 导出统一走系统保存对话框，原图可附参数 txt
- **批量队列**：一键把当前参数加入队列，支持 1–4 并发、逐条取消 / 重试；重启后未完成任务标为中断且不自动重跑
- **可取消生成**：点「停止」立即丢弃未落盘结果、界面不再等待；上游请求为协作式取消（在请求前 / 返回后 / 落盘前检查标志，不保证服务商侧停止计费），已生成的图片保留
- **双主题与玻璃质感**：浅色 / 暗色，跟随系统；标题栏、侧栏、右栏与浮层统一走 Liquid Glass 功能层，可在设置里选「清晰 / 标准 / 着色」三档通透度，并可开启「减少透明效果」；全站过渡动画遵循「减少动态」偏好
- **三层材质与无边框窗口**：自绘 48px 标题栏（拖动 / 双击最大化 / 8 向缩放 / 最小化关闭），窗口材质、内容面、功能玻璃分层，环境底纹为玻璃提供采样源；页面切换与弹层使用物理弹簧
- **命令面板与快捷键**：`Ctrl K` 搜命令、页面与设置，`Ctrl B / N / 1–5 / , / F` 与 `F1` 覆盖常用操作；画廊支持 Shift 连选与 `Ctrl A`，画布支持 `Ctrl S / 0 / +/- / V` 与删除
- **画廊批量操作**：Shift 连选、全选、底部浮动工具栏（对比 / 导出 / 取消），大图查看器带胶片条、复制提示词与下载
- **存储治理**：媒体根可整体迁移（图片 / 参考图 / 缩略图 / 回收站），存储占用统计 + 孤儿缓存自动回收（保留天数可调）
- **数据备份**：配置与偏好一键导出/导入（默认不含明文 Key，可选包含；支持多 Key 往返；v4 含收藏与工作流预设，换机迁移）
- **诊断与更新**：按天滚动日志（保留 7 天）+ 一键导出脱敏诊断包；应用内检查 / 下载 / 安装更新（更新源待配置）

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

打包前先退出正在运行的墨灵（包括 `start.bat -Release` 启动的实例）：Windows 会锁住 `src-tauri/target/release/moling.exe`，`cargo` 链接完成后删不掉旧文件，构建会以 `failed to remove file ... 拒绝访问` 失败。

### 更新链路测试构建

常规构建**不产出更新制品**（`bundle.createUpdaterArtifacts` 默认 false），因此没有签名密钥也能正常打包。要验证应用内更新，用测试配置覆盖一次：

```bash
# 私钥放仓库外，构建时通过环境变量提供
export TAURI_SIGNING_PRIVATE_KEY="$USERPROFILE/.moling-updater-test/moling-test.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<测试口令>"
pnpm tauri build --bundles nsis --config src-tauri/tauri.updater-test.conf.json
```

测试配置把更新端点指向 `http://127.0.0.1:8787/latest.json`。完整验收步骤（生成密钥对、本地清单服务、篡改包必须被拒）见[开发规范](墨灵_开发规范.md)「七、测试与质量门禁 → 更新链路本地验收」。

### 正式发布（GitHub Releases）

更新源为 GitHub Releases，客户端读取固定别名
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`。

**打 tag 即触发发布**（`.github/workflows/release.yml`）：

```bash
git tag -a v1.0.1 -m "更新说明"
git push origin v1.0.1
```

流水线依次执行：前端门禁 + Rust 门禁（`fmt` / `clippy` / `test` / `audit`）→ 校验 tag 与双版本号一致 → 生成发布配置 → 带签名构建 NSIS → 更新包重命名为 ASCII → 生成 `latest.json` → 建 Release → 上传安装包与 `.sig` → **最后**上传 `latest.json`（顺序保证中途失败时存量客户端不会 404；ASCII 重命名是因为 GitHub 会丢弃中文资产名，导致清单地址 404）。

前置条件：仓库 Secrets 需配置 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；发版前同步 `src-tauri/tauri.conf.json` 与 `package.json` 的版本号。

本地等价命令：

```bash
pnpm release:config        # 按 git remote origin 生成端点与 createUpdaterArtifacts
pnpm tauri build --config src-tauri/tauri.release.conf.json --bundles nsis
pnpm release:manifest --notes "更新说明"
```

端点在构建期生成、不硬编码，换 fork 或改仓库名只需重新跑 `release:config`。**公钥编译进二进制后不可更换**：私钥或口令丢失将导致存量用户永久无法更新，保管要求见[开发规范](墨灵_开发规范.md)「正式发布」。

## 技术栈

Tauri 2（Rust）· React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · Zustand · SQLite（rusqlite）· framer-motion（物理弹簧）· Radix 原语（`src/components/ui/` 封装）

平台：仅支持 **Windows**（密钥主密钥依赖 Windows 凭据管理器 DPAPI，见 `src-tauri/src/storage.rs`）。

## 测试与质量门禁

```bash
# 前端：类型检查 + ESLint + 格式检查 + 单测 + 生产构建
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm test
pnpm build

# 后端：格式 + Clippy（零告警）+ 依赖漏洞扫描 + 单元测试
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo audit
cargo test
```

工具链版本由根目录 `rust-toolchain.toml`（Rust 1.98.1）与 `.nvmrc`（Node 24.11.1）固定，`package.json` 的 `engines` 约束 Node ≥ 22.12 与 pnpm ≥ 11。

CI（`.github/workflows/ci.yml`）在 Windows 上执行同一组门禁，并对生产依赖做 `pnpm audit --prod --audit-level high`。

设计令牌卡口与界面手测矩阵见[开发规范](墨灵_开发规范.md)「七、测试与质量门禁」：任意值类、裸色、`text-white`、`backdrop-blur` 与 UI 层直接 import `@radix-ui/*` 都不允许合入。

## 目录结构

```
start.bat / stop.bat  一键启停入口（薄包装，逻辑在 scripts/）
scripts/              启停脚本（PowerShell 5.1）：前置检查、后台启动、pid/日志、进程树回收
src/
  components/         React 界面（含 shell/ 窗口外壳、ui/ 组件库、settings/ 设置分段）
  stores/             Zustand 状态（app / chat / provider / queue / promptAssets / canvas）
  hooks/              useWindowState · useScrollEdge · useMediaQuery · useGlobalShortcuts
  lib/                api / theme / motion / commands / shortcuts / notify / file …
public/theme-boot.js  首帧同步恢复外观，消除启动白闪
src-tauri/src/        Rust 后端
  adapters/           适配器协议与实现（openai / template / mock / chat / http）
  commands/           Tauri 命令（providers / network / settings / image / queue / chat / thinking /
                      prompt_assets / storage / canvas / diagnostics / update）
  storage.rs          SQLite 存储、迁移与 Key 加密（AES-256-GCM）
  key_pool.rs         多 Key 候选序列、失效标记与切换
  logging.rs          按天滚动日志与 7 天保留
  image_store.rs      图片落盘、缩略图、base64 富化与旧数据惰性迁移（媒体根可迁移）
  image_gc.rs         孤儿图片 / 参考图回收与缓存清理
  error.rs            统一错误类型与前端可解析的错误码
  paths.rs            应用数据目录与媒体根解析
```

## 文档

- [产品功能文档](墨灵_产品功能文档.md)：功能清单、界面交互与里程碑状态
- [设计规范](墨灵_设计规范.md)：视觉语言、设计令牌、组件与交互基线（最高优先级）
- [开发规范](墨灵_开发规范.md)：架构、存储硬规则、ADR、编码规范、启停脚本契约、门禁、技术债与下一步计划

## 许可

[MIT](LICENSE)
