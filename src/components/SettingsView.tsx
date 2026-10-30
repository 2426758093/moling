import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, ProviderItem } from "../lib/api";
import { useProviderStore } from "../stores/providerStore";
import { useAppStore } from "../stores/appStore";
import { toast } from "../lib/notify";
import type { GlassAppearance, ThemeMode } from "../lib/types";
import { isUiMode } from "../lib/types";
import { useScrollEdge } from "../hooks/useScrollEdge";
import PageHeader from "./PageHeader";
import ProviderDialog from "./settings/ProviderDialog";
import ProviderCard from "./settings/ProviderCard";
import ThinkingSection from "./settings/ThinkingSection";
import AboutSection from "./settings/AboutSection";
import NetworkSection from "./settings/NetworkSection";
import StorageSection from "./settings/StorageSection";
import { Button } from "./ui/Button";
import { Section, Row } from "./ui/List";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Switch } from "./ui/Switch";
import { IconPlus } from "./Icons";

const THEME_OPTIONS = [
  { value: "system" as const, label: "跟随系统" },
  { value: "light" as const, label: "浅色" },
  { value: "dark" as const, label: "暗色" },
];

const GLASS_OPTIONS = [
  { value: "clear" as const, label: "清晰" },
  { value: "standard" as const, label: "标准" },
  { value: "tinted" as const, label: "着色" },
];

const MODE_OPTIONS = [
  { value: "simple" as const, label: "简单" },
  { value: "expert" as const, label: "专家" },
];

export default function SettingsView() {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const refresh = useProviderStore((s) => s.refresh);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderItem | null>(null);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const glass = useAppStore((s) => s.glass);
  const setGlass = useAppStore((s) => s.setGlass);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useScrollEdge(scrollRef);

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

  /// 导入成功后把本机 UI 状态同步到新配置：外观立即生效，默认参数写回 store
  const reloadImportedSettings = async () => {
    const savedTheme = await api.getSetting("theme");
    if (
      savedTheme === "system" ||
      savedTheme === "light" ||
      savedTheme === "dark"
    ) {
      setTheme(savedTheme);
    }
    const savedGlass = await api.getSetting("glassAppearance");
    if (
      savedGlass === "clear" ||
      savedGlass === "standard" ||
      savedGlass === "tinted"
    ) {
      setGlass(savedGlass);
    }
    const savedMode = await api.getSetting("uiMode");
    if (isUiMode(savedMode)) setMode(savedMode);
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <PageHeader title="设置" subtitle="服务商、外观与数据" />
      <div
        ref={scrollRef}
        className="scroll-edge min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          <Section
            title="服务商管理"
            description="至少添加一个服务商才能开始生成"
            action={
              <Button
                size="sm"
                variant="primary"
                icon={<IconPlus size={14} />}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                新增服务商
              </Button>
            }
          >
            {providers.length === 0 ? (
              <div className="p-10 text-center text-body text-tertiary">
                还没有服务商。点击「新增服务商」，填入地址和 Key 即可开始绘图。
              </div>
            ) : (
              providers.map((item) => (
                <ProviderCard
                  key={item.provider.id}
                  item={item}
                  onEdit={() => {
                    setEditing(item);
                    setDialogOpen(true);
                  }}
                />
              ))
            )}
          </Section>

          <Section title="外观与默认项">
            <Row label="主题" hint="跟随系统时会随操作系统切换">
              <SegmentedControl
                value={theme}
                onValueChange={(v) => setTheme(v as ThemeMode)}
                label="主题"
                size="sm"
                options={THEME_OPTIONS}
              />
            </Row>
            <Row label="玻璃质感" hint="影响侧栏、栏头与浮层的通透程度">
              <SegmentedControl
                value={glass}
                onValueChange={(v) => setGlass(v as GlassAppearance)}
                label="玻璃质感"
                size="sm"
                options={GLASS_OPTIONS}
              />
            </Row>
            <Row
              label="界面模式"
              hint="简单模式只保留提示词、比例、风格与张数；专家模式显示负向词、队列与自定义尺寸"
            >
              <SegmentedControl
                value={mode}
                onValueChange={(v) => setMode(v as "simple" | "expert")}
                label="界面模式"
                size="sm"
                options={MODE_OPTIONS}
              />
            </Row>
            <Row label="默认生成参数" hint="决定新对话里的比例、风格与张数">
              <Button
                size="sm"
                onClick={() =>
                  api
                    .setSetting("defaultParams", JSON.stringify(prefs))
                    .then(() => toast("已保存为默认参数"))
                    .catch((e) =>
                      toast(`保存默认参数失败：${String(e)}`, "error"),
                    )
                }
              >
                将当前设为默认
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  const saved = await api.getSetting("defaultParams");
                  if (!saved) return;
                  try {
                    setPrefs(JSON.parse(saved));
                    toast("已恢复默认参数");
                  } catch {
                    toast("默认参数损坏，无法恢复", "error");
                  }
                }}
              >
                恢复默认
              </Button>
            </Row>
          </Section>

          <StorageSection dataDir={dataDir} />

          <ThinkingSection key={thinkingKey} />

          <NetworkSection />

          <AboutSection />

          <Section
            title="诊断日志"
            description="诊断包包含近 7 天日志、应用版本与系统信息、服务商元信息与设置项；不含图片、提示词与任何 API Key。日志里可能带上游返回的错误信息，分享前请自行确认。"
          >
            <Row label="日志目录">
              <span className="max-w-xs truncate text-footnote text-tertiary">
                {logsDir}
              </span>
            </Row>
            <Row label="导出诊断包">
              <Button
                size="sm"
                loading={diagBusy}
                onClick={() => doExportDiagnostics().catch(() => undefined)}
              >
                导出诊断包
              </Button>
              {diagPath && (
                <Button
                  size="sm"
                  onClick={() =>
                    revealItemInDir(diagPath).catch((e) =>
                      toast(`打开目录失败：${String(e)}`, "error"),
                    )
                  }
                >
                  打开所在目录
                </Button>
              )}
            </Row>
            {diagPath && (
              <div className="px-4 pb-3 text-footnote text-tertiary">
                已导出：{diagPath}
              </div>
            )}
          </Section>

          <Section title="数据备份" description="导出后可迁移到另一台设备">
            <Row label="导出全部配置">
              <Button
                size="sm"
                onClick={() => doExport().catch(() => undefined)}
              >
                导出配置
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                导入配置
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) doImport(f).catch(() => undefined);
                  e.target.value = "";
                }}
              />
            </Row>
            <Row
              label="同时导出 API Key"
              hint="明文写入备份文件，仅用于本机迁移"
            >
              <Switch
                checked={includeKeys}
                onCheckedChange={setIncludeKeys}
                label="同时导出 API Key"
              />
            </Row>
            {(includeKeys || backupMsg) && (
              <div className="space-y-1 px-4 pb-3">
                {includeKeys && (
                  <p className="text-footnote text-danger">
                    导出文件将包含明文密钥，请勿分享或上传。
                  </p>
                )}
                {backupMsg && (
                  <p className="text-footnote text-tertiary">{backupMsg}</p>
                )}
              </div>
            )}
          </Section>
        </div>
      </div>
      {dialogOpen && <ProviderDialog initial={editing} onClose={closeDialog} />}
    </div>
  );
}
