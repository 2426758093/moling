import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, ProviderItem } from "../lib/api";
import { saveTextFile } from "../lib/save";
import { useProviderStore } from "../stores/providerStore";
import { sanitizePrefs, useAppStore } from "../stores/appStore";
import { toast } from "../lib/notify";
import type { GlassAppearance } from "../lib/types";
import { isUiMode, qualityLabel, sizeLabel } from "../lib/types";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { SHORTCUTS } from "../lib/shortcuts";
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
import { Kbd } from "./ui/Kbd";
import { IconMonitor, IconMoon, IconPlus, IconSun } from "./Icons";
import { cn } from "./ui/cn";

const THEME_OPTIONS = [
  {
    value: "system" as const,
    label: "跟随系统",
    icon: <IconMonitor size={16} />,
  },
  { value: "light" as const, label: "浅色", icon: <IconSun size={16} /> },
  { value: "dark" as const, label: "暗色", icon: <IconMoon size={16} /> },
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

type SettingsSection =
  | "providers"
  | "appearance"
  | "generation"
  | "network"
  | "storage"
  | "diagnostics"
  | "about"
  | "shortcuts";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "providers", label: "服务商" },
  { id: "appearance", label: "外观" },
  { id: "generation", label: "生成" },
  { id: "network", label: "网络" },
  { id: "storage", label: "存储" },
  { id: "diagnostics", label: "诊断" },
  { id: "about", label: "关于" },
  { id: "shortcuts", label: "快捷键" },
];

const SHORTCUT_GROUPS = ["全局", "画布", "列表"] as const;

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
  const [section, setSection] = useState<SettingsSection>("providers");
  const reduceTransparency = useAppStore((s) => s.reduceTransparency);
  const setReduceTransparency = useAppStore((s) => s.setReduceTransparency);
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

  const toggleTransparency = (on: boolean) => {
    setReduceTransparency(on);
  };

  const doExport = async () => {
    try {
      const data = await api.exportConfig(includeKeys);
      const saved = await saveTextFile(
        JSON.stringify(data, null, 2),
        `moling_backup_${Date.now()}.json`,
      );
      if (!saved) return; // 用户取消保存
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="设置" subtitle="服务商、外观与数据" />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="设置分区"
          className="flex w-44 shrink-0 flex-col gap-0.5 px-3 py-4"
        >
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
              className={cn(
                "pressable flex h-8 items-center rounded-btn px-2.5 text-left text-callout transition-colors",
                section === item.id
                  ? "bg-elevated text-primary shadow-card"
                  : "text-secondary hover:bg-hover hover:text-primary",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div
          ref={scrollRef}
          className="scroll-edge min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto max-w-settings space-y-6 px-4 py-4 wide:max-w-settings-wide">
            {section === "providers" && (
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
                    还没有服务商。点击「新增服务商」，填入地址和 Key
                    即可开始绘图。
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
            )}

            {section === "appearance" && (
              <Section title="外观" description="主题、材质与信息密度">
                <div className="grid grid-cols-3 gap-2 p-2">
                  {THEME_OPTIONS.map((option) => {
                    const active = theme === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setTheme(option.value)}
                        className={cn(
                          "pressable flex flex-col items-center gap-2 rounded-card border px-2 py-3 text-footnote transition-colors",
                          active
                            ? "border-accent bg-accent-soft text-accent-text"
                            : "border-line bg-elevated text-secondary hover:bg-hover hover:text-primary",
                        )}
                      >
                        {option.icon}
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <Row label="玻璃质感" hint="影响侧栏、标题栏与浮层的通透程度">
                  <SegmentedControl
                    value={glass}
                    onValueChange={(v) => setGlass(v as GlassAppearance)}
                    label="玻璃质感"
                    size="sm"
                    options={GLASS_OPTIONS}
                  />
                </Row>
                <div className="px-3 pb-3">
                  <div className="rounded-card bg-grouped p-3">
                    <div className="glass rounded-card px-3 py-2 text-footnote text-secondary shadow-card">
                      浮层控制预览 · 玻璃只用在内容之上
                    </div>
                  </div>
                </div>
                <Row
                  label="减少透明效果"
                  hint="关闭玻璃模糊、改用纯色面板，低性能设备更流畅"
                >
                  <Switch
                    checked={reduceTransparency}
                    onCheckedChange={toggleTransparency}
                    label="减少透明效果"
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
              </Section>
            )}

            {section === "generation" && (
              <>
                <Section
                  title="默认生成参数"
                  description="决定新对话里的比例、风格与张数"
                >
                  <Row label="当前参数" hint="以聊天页 Composer 里的设置为准">
                    <span className="text-footnote text-tertiary">
                      {sizeLabel(prefs.width, prefs.height)} · 质量{" "}
                      {qualityLabel(prefs.quality)} · {prefs.count} 张
                    </span>
                  </Row>
                  <Row label="设为默认">
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
                          setPrefs(sanitizePrefs(JSON.parse(saved)));
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
                <ThinkingSection key={thinkingKey} />
              </>
            )}

            {section === "network" && <NetworkSection />}

            {section === "storage" && (
              <>
                <StorageSection dataDir={dataDir} />
                <Section
                  title="数据备份"
                  description="导出后可迁移到另一台设备"
                >
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
                    <div className="space-y-1 px-3 pb-3">
                      {includeKeys && (
                        <p className="text-footnote text-danger">
                          导出文件将包含明文密钥，请勿分享或上传。
                        </p>
                      )}
                      {backupMsg && (
                        <p className="text-footnote text-tertiary">
                          {backupMsg}
                        </p>
                      )}
                    </div>
                  )}
                </Section>
              </>
            )}

            {section === "diagnostics" && (
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
            )}

            {section === "about" && <AboutSection />}

            {section === "shortcuts" &&
              SHORTCUT_GROUPS.map((group) => (
                <Section
                  key={group}
                  title={group}
                  description={
                    group === "全局" ? "在任何页面都可用" : undefined
                  }
                >
                  {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                    <Row
                      key={s.keys}
                      label={
                        <span className="text-callout text-secondary">
                          {s.label}
                        </span>
                      }
                    >
                      <Kbd>{s.keys}</Kbd>
                    </Row>
                  ))}
                </Section>
              ))}
          </div>
        </div>
      </div>
      {dialogOpen && <ProviderDialog initial={editing} onClose={closeDialog} />}
    </div>
  );
}
