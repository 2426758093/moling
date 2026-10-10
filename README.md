# 墨灵 MoLing

像聊天一样作图 —— 可接入任意绘图 API 的桌面端 AI 绘图工具。

墨灵是「绘图优先 + 任意 OpenAI 兼容 API + 桌面客户端」的 AI 绘图产品：填入任意服务商的 API 地址与 Key 即可开始作图，支持思考模型前置理解、参考图、上下文改图与局部重绘。

## 功能

- **聊天式文生图**：像发消息一样描述画面，逐轮生成、保留完整对话历史
- **思考模型（前置理解层）**：生成前先用大模型理解意图、扩写提示词；支持独立配置或复用绘图服务商，失败自动降级
- **参考图**：上传图片或一键引用历史图片，随请求上送，多轮上下文改图
- **图像编辑**：局部重绘（涂抹蒙版）、结果自动回流对话
- **服务商接入**：OpenAI 兼容接口 / 自定义占位符模板 / Mock 调试适配器；Key 本地 AES-256-GCM 加密存储
- **画廊**：生成记录、筛选收藏、复用参数、批量打包导出（含参数 JSON）
- **双主题**：浅色 / 暗色精修，跟随系统，全站过渡动画
- **数据备份**：配置一键导出/导入，换机迁移

## 技术栈

Tauri 2（Rust）· React 19 · TypeScript · Vite · Tailwind CSS 4 · Zustand · SQLite（rusqlite）· framer-motion

## 开发

平台：仅支持 **Windows**（密钥主密钥依赖 Windows 凭据管理器 DPAPI，见 `src-tauri/src/storage.rs`）。

前置：Node.js ≥ 20、pnpm、Rust 工具链（[rustup](https://rustup.rs/)）、Windows 需 MSVC 生成工具。

```bash
pnpm install
pnpm tauri dev      # 开发模式（热更新）
```

## 构建

```bash
pnpm tauri build --bundles nsis
# 产物：src-tauri/target/release/bundle/nsis/墨灵_*_x64-setup.exe
```

## 测试

```bash
cd src-tauri && cargo test
```

## 目录结构

```
src/                 React 前端（components / stores / lib）
src-tauri/src/       Rust 后端
  adapters/          适配器协议与实现（openai / template / mock / chat）
  commands.rs        Tauri 命令（服务商 / 生成 / 思考 / 会话）
  storage.rs         SQLite 存储与 Key 加密
```

## 许可

[MIT](LICENSE)

## 更多文档

- [开发文档](墨灵_开发文档.md)：架构、设计决策、现状清单与路线图
- [CHANGELOG](CHANGELOG.md)：版本演进记录
