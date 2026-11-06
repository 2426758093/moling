# 墨灵 MoLing

> 像聊天一样作图 —— 可接入任意 OpenAI 兼容 API 的 Windows 桌面端 AI 绘图工具。

墨灵把 AI 绘图做成聊天：描述你想要的画面，模型逐轮生成，上下文持续累积。它不绑定任何服务商，填入任意 OpenAI 兼容的 API 地址、模型与 Key 即可使用。

## 功能亮点

- **聊天式文生图**：逐轮生成、保留完整会话，可随时复用历史参数
- **任意服务商**：OpenAI 兼容接口、自定义模板与 Mock 调试，支持多 Key 自动切换与代理
- **多轮改图**：参考图随请求上送，支持局部重绘、AI 消除、扩图、换背景、放大与风格转换
- **提示词助手**：模板库、灵感骰子、图片反推、中英互译与 AI 优化
- **画布工作区**：作品拖入无限画布排布、缩放、连线，节点可直接进入编辑
- **画廊与批量队列**：时间线浏览、筛选与对比、打包导出；队列支持 1–4 全局并发、每服务商 1–2 并发与逐条重试
- **桌面原生体验**：无边框窗口、Liquid Glass 主题、命令面板与全局快捷键
- **本地优先**：图片与数据存于本机，API Key 使用 AES-256-GCM 加密保存

## 下载与安装

前往 [Releases](https://github.com/2426758093/moling/releases/latest) 下载 Windows x64 安装包：

1. 运行 `moling_<版本>_x64-setup.exe` 完成安装；
2. 在「设置 → 服务商」填写 API 地址、模型与 Key；
3. 回到会话，直接描述你想要的画面。

应用支持应用内检查并安装更新。

## 系统要求

- Windows 10 / 11 x64
- 自备任意 OpenAI 兼容绘图 API 的访问凭证（应用不内置 Key，也不代理任何服务）

## 技术栈

Tauri 2（Rust）· React 19 · TypeScript · Vite · Tailwind CSS 4 · Zustand · SQLite

## 本地开发

需要 Node.js ≥ 22.12、pnpm ≥ 11 与 Rust 工具链（版本分别由 `.nvmrc` 与 `rust-toolchain.toml` 固定）。

```bash
pnpm install
pnpm tauri dev
```

构建安装包：

```bash
pnpm tauri build --bundles nsis
```

## 许可

[MIT](LICENSE)
