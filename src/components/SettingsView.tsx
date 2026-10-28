import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, ProviderItem } from "../lib/api";
import { useProviderStore } from "../stores/providerStore";
import { useAppStore } from "../stores/appStore";
import { toast } from "../lib/notify";
import ProviderDialog from "./settings/ProviderDialog";
import ProviderCard from "./settings/ProviderCard";
import ThinkingSection from "./settings/ThinkingSection";
import NetworkSection from "./settings/NetworkSection";

export default function SettingsView() {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const refresh = useProviderStore((s) => s.refresh);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderItem | null>(null);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const prefs = useAppStore((s) => s.prefs);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const [dataDir, setDataDir] = useState("");
  const [logsDir, setLogsDir] = useState("");
  const [diagPath, setDiagPath] = useState("");
  const [diagBusy, setDiagBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState("");
  // 默认不导出明文 Key；勾选后才写进备份文件
  const [includeKeys, setIncludeKeys] = useState(false);
  // 导入后强制重挂思考模型区，重新读取导入的配置
  const [thinkingKey, setThinkingKey] = useState(0);

  useEffect(() => {
    if (!loaded) refresh();
    api
      .getAppDataDir()
      .then(setDataDir)
      .catch(() => undefined);
    api
      .getLogsDir()
      .then(setLogsDir)
      .catch(() => undefined);
  }, [loaded, refresh]);

  const doExportDiagnostics = async () => {
    setDiagBusy(true);
    try {
      setDiagPath(await api.exportDiagnostics());
    } catch (e) {
      toast(`导出诊断包失败：${String(e)}`, "error");
    } finally {
      setDiagBusy(false);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditing(null);
  };

  const doExport = async () => {
    try {
      const data = await api.exportConfig(includeKeys);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `moling_backup_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setBackupMsg(
        includeKeys
          ? "已导出（包含明文 API Key，请勿分享或上传）"
          : "已导出（不含 API Key）",
      );
    } catch (e) {
      setBackupMsg(`导出失败：${String(e)}`);
    }
  };

  /// 导入成功后把本机 UI 状态同步到新配置：主题立即生效，默认参数写回 store
  const reloadImportedSettings = async () => {
    const savedTheme = await api.getSetting("theme");
    if (
      savedTheme === "system" ||
      savedTheme === "light" ||
      savedTheme === "dark"
    ) {
      setTheme(savedTheme);
    }
    const savedPrefs = await api.getSetting("defaultParams");
    if (!savedPrefs) return;
    try {
      const patch = JSON.parse(savedPrefs);
      setPrefs({ ...prefs, ...patch });
    } catch {
      // 忽略损坏的默认参数
    }
  };

  const doImport = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      await api.importConfig(data);
      await refresh();
      await reloadImportedSettings();
      setThinkingKey((k) => k + 1);
      setBackupMsg("导入成功");
    } catch (e) {
      setBackupMsg(`导入失败：${String(e)}`);
    }
  };

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-base">
      <header className="bg-glass z-10 flex h-[52px] shrink-0 items-end border-b border-theme px-6 pb-2">
        <h1 className="text-[17px] font-semibold tracking-tight text-primary">
          设置
        </h1>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">服务商管理</h2>
              <button
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
                className="rounded-[10px] bg-accent px-4 py-2 text-sm text-white"
              >
                + 新增服务商
              </button>
            </div>
            {providers.length === 0 ? (
              <div className="rounded-[var(--radius-card)] border border-dashed border-theme p-10 text-center text-sm text-tertiary">
                还没有服务商。点击「新增服务商」，填入地址和 Key 即可开始绘图。
              </div>
            ) : (
              <div className="space-y-3">
                {providers.map((item) => (
                  <ProviderCard
                    key={item.provider.id}
                    item={item}
                    onEdit={() => {
                      setEditing(item);
                      setDialogOpen(true);
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-4 text-lg font-semibold">外观与默认项</h2>
            <div className="space-y-3 rounded-[var(--radius-card)] border border-theme p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-secondary">主题</span>
                <select
                  value={theme}
                  onChange={(e) =>
                    setTheme(e.target.value as "system" | "light" | "dark")
                  }
                  className="rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">暗色</option>
                </select>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-secondary">默认生成参数</span>
                <div className="flex gap-2 text-xs">
                  <button
                    onClick={() =>
                      api
                        .setSetting("defaultParams", JSON.stringify(prefs))
                        .catch((e) =>
                          toast(`保存默认参数失败：${String(e)}`, "error"),
                        )
                    }
                    className="rounded-[8px] border border-theme px-2 py-1"
                  >
                    将当前设为默认
                  </button>
                  <button
                    onClick={async () => {
                      const saved = await api.getSetting("defaultParams");
                      if (!saved) return;
                      try {
                        setPrefs(JSON.parse(saved));
                      } catch {
                        toast("默认参数损坏，无法恢复", "error");
                      }
                    }}
                    className="rounded-[8px] border border-theme px-2 py-1"
                  >
                    恢复默认
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-secondary">存储路径</span>
                <span className="max-w-[60%] truncate text-xs text-tertiary">
                  {dataDir}
                </span>
              </div>
            </div>
          </section>

          <ThinkingSection key={thinkingKey} />

          <NetworkSection />

          <section>
            <h2 className="mb-4 text-lg font-semibold">诊断日志</h2>
            <div className="space-y-3 rounded-[var(--radius-card)] border border-theme p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-secondary">日志目录</span>
                <span className="max-w-[60%] truncate text-xs text-tertiary">
                  {logsDir}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-tertiary">
                诊断包包含近 7
                天日志、应用版本与系统信息、服务商元信息与设置项；
                不含图片、提示词与任何 API Key。日志里可能带上游返回的错误信息，
                分享前请自行确认。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => doExportDiagnostics().catch(() => undefined)}
                  disabled={diagBusy}
                  className="rounded-[8px] border border-theme px-3 py-1.5 text-xs transition-opacity disabled:opacity-50"
                >
                  {diagBusy ? "打包中…" : "导出诊断包"}
                </button>
                {diagPath && (
                  <>
                    <button
                      onClick={() =>
                        revealItemInDir(diagPath).catch((e) =>
                          toast(`打开目录失败：${String(e)}`, "error"),
                        )
                      }
                      className="rounded-[8px] border border-theme px-3 py-1.5 text-xs"
                    >
                      打开所在目录
                    </button>
                    <span className="w-full truncate text-xs text-tertiary">
                      已导出：{diagPath}
                    </span>
                  </>
                )}
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-4 text-lg font-semibold">数据备份</h2>
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-theme p-4">
              <button
                onClick={() => doExport().catch(() => undefined)}
                className="rounded-[8px] border border-theme px-3 py-1.5 text-xs"
              >
                导出全部配置
              </button>
              <label className="cursor-pointer rounded-[8px] border border-theme px-3 py-1.5 text-xs">
                导入配置
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) doImport(f).catch(() => undefined);
                    e.target.value = "";
                  }}
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-secondary">
                <input
                  type="checkbox"
                  checked={includeKeys}
                  onChange={(e) => setIncludeKeys(e.target.checked)}
                />
                同时导出 API Key（明文，仅用于本机迁移）
              </label>
              {includeKeys && (
                <span className="text-xs text-danger">
                  导出文件将包含明文密钥，请勿分享或上传
                </span>
              )}
              {backupMsg && (
                <span className="w-full text-xs text-tertiary">
                  {backupMsg}
                </span>
              )}
            </div>
          </section>
        </div>
      </div>
      {dialogOpen && <ProviderDialog initial={editing} onClose={closeDialog} />}
    </div>
  );
}
