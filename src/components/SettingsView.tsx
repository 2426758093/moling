import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import RequestsSection from "./settings/RequestsSection";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { Section, Row } from "./ui/List";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Switch } from "./ui/Switch";
import { Kbd } from "./ui/Kbd";
import { IconMonitor, IconMoon, IconPlus, IconSun } from "./Icons";
import { cn } from "./ui/cn";
import { useStylePresetStore } from "../stores/stylePresetStore";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "跟随系统",
    icon: <IconMonitor size={16} />,
  },
  { value: "light", label: "浅色", icon: <IconSun size={16} /> },
  { value: "dark", label: "暗色", icon: <IconMoon size={16} /> },
] as const;

const GLASS_OPTIONS = [
  { value: "clear", label: "清晰" },
  { value: "standard", label: "标准" },
  { value: "tinted", label: "着色" },
] as const;

const MODE_OPTIONS = [
  { value: "simple", label: "简单" },
  { value: "expert", label: "专家" },
] as const;

// 语言名用各自母语显示，切到英文后也能认出「简体中文」
const LOCALE_OPTIONS = [
  { value: "zh-CN" as const, label: "简体中文" },
  { value: "en-US" as const, label: "English" },
];

type SettingsSection =
  | "providers"
  | "appearance"
  | "generation"
  | "network"
  | "storage"
  | "requests"
  | "diagnostics"
  | "about"
  | "shortcuts";

const SECTIONS = [
  { id: "providers", label: "服务商" },
  { id: "appearance", label: "外观" },
  { id: "generation", label: "生成" },
  { id: "network", label: "网络" },
  { id: "storage", label: "存储" },
  { id: "requests", label: "请求记录" },
  { id: "diagnostics", label: "诊断" },
  { id: "about", label: "关于" },
  { id: "shortcuts", label: "快捷键" },
] as const;

const SHORTCUT_GROUPS = ["全局", "画布", "列表"] as const;

/// 智能蒙版开关：默认开启；关闭后编辑器的「点选物体」与换背景的
/// 「自动选中背景」入口整体隐藏，行为回到 1.2.7 的纯手动画笔。
function SmartMaskRow() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .getSetting("smartMask")
      .then((v) => setEnabled(v !== "off"))
      .catch(() => setEnabled(true));
  }, []);
  return (
    <Row
      label={t("启用智能蒙版")}
      hint={t(
        "一键选中背景、点选要消除的物体；首次使用会加载本地模型，之后约 0.1–0.5 秒出结果",
      )}
    >
      <Switch
        checked={enabled ?? true}
        disabled={enabled === null}
        onCheckedChange={(v) => {
          setEnabled(v);
          api
            .setSetting("smartMask", v ? "on" : "off")
            .then(() => toast(t("已保存智能蒙版设置")))
            .catch((e) =>
              toast(t("保存失败：{{error}}", { error: String(e) }), "error"),
            );
        }}
        label={t("启用智能蒙版")}
      />
    </Row>
  );
}

/// 队列自动续跑：启动时只恢复排队中的任务；中断任务需在队列页手动恢复。
function QueueAutoResumeRow() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .getSetting("queueAutoResume")
      .then((v) => setEnabled(v === "on"))
      .catch(() => setEnabled(false));
  }, []);
  return (
    <Row
      label={t("启动时自动续跑队列")}
      hint={t(
        "只处理排队中的任务；上次中断的任务仍需在队列页手动恢复，避免重复计费",
      )}
    >
      <Switch
        checked={enabled ?? false}
        disabled={enabled === null}
        onCheckedChange={(v) => {
          setEnabled(v);
          api
            .setSetting("queueAutoResume", v ? "on" : "off")
            .then(() => toast(t("已保存队列设置")))
            .catch((e) =>
              toast(t("保存失败：{{error}}", { error: String(e) }), "error"),
            );
        }}
        label={t("启动时自动续跑队列")}
      />
    </Row>
  );
}

/// 自定义风格：与内置风格同源展示在 Composer / 风格转换里，只存增量部分
function StylePresetsSection() {
  const { t } = useTranslation();
  const custom = useStylePresetStore((s) => s.custom);
  const addCustom = useStylePresetStore((s) => s.addCustom);
  const removeCustom = useStylePresetStore((s) => s.removeCustom);
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const canAdd = !busy && label.trim() !== "" && prompt.trim() !== "";
  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    const ok = await addCustom(label, prompt);
    setBusy(false);
    if (ok) {
      setLabel("");
      setPrompt("");
      toast(t("已添加风格"));
    }
  };

  return (
    <Section
      title={t("自定义风格")}
      description={t("与内置风格一起出现在生成与风格转换里")}
    >
      {custom.map((p) => (
        <Row key={p.id} label={p.label} hint={p.prompt}>
          <Button size="sm" onClick={() => void removeCustom(p.id)}>
            {t("删除")}
          </Button>
        </Row>
      ))}
      <div className="flex flex-col gap-2 px-3 py-2">
        <Input
          label={t("风格名称")}
          value={label}
          maxLength={40}
          placeholder={t("例如：暖调胶片")}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          label={t("风格提示词")}
          value={prompt}
          maxLength={500}
          placeholder={t("例如：warm analog film, soft grain")}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex justify-end">
          <Button size="sm" variant="primary" disabled={!canAdd} onClick={add}>
            <IconPlus size={14} />
            {t("添加风格")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

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
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const { t } = useTranslation();
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
  const canvasInline = useAppStore((s) => s.canvasInline);
  const setCanvasInline = useAppStore((s) => s.setCanvasInline);
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
      toast(t("导出诊断包失败：{{error}}", { error: String(e) }), "error");
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
          ? t("已导出（包含明文 API Key，请勿分享或上传）")
          : t("已导出（不含 API Key）"),
      );
    } catch (e) {
      setBackupMsg(t("导出失败：{{error}}", { error: String(e) }));
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
      setBackupMsg(t("导入成功"));
    } catch (e) {
      setBackupMsg(t("导入失败：{{error}}", { error: String(e) }));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title={t("设置")} subtitle={t("服务商、外观与数据")} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("设置分区")}
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
              {t(item.label)}
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
                title={t("服务商管理")}
                description={t("至少添加一个服务商才能开始生成")}
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
                    {t("新增服务商")}
                  </Button>
                }
              >
                {providers.length === 0 ? (
                  <div className="p-10 text-center text-body text-tertiary">
                    {t(
                      "还没有服务商。点击「新增服务商」，填入地址和 Key 即可开始绘图。",
                    )}
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
              <Section
                title={t("外观")}
                description={t("主题、材质与信息密度")}
              >
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
                        {t(option.label)}
                      </button>
                    );
                  })}
                </div>
                <Row
                  label={t("玻璃质感")}
                  hint={t("影响侧栏、标题栏与浮层的通透程度")}
                >
                  <SegmentedControl
                    value={glass}
                    onValueChange={(v) => setGlass(v as GlassAppearance)}
                    label={t("玻璃质感")}
                    size="sm"
                    options={GLASS_OPTIONS.map((o) => ({
                      ...o,
                      label: t(o.label),
                    }))}
                  />
                </Row>
                <div className="px-3 pb-3">
                  <div className="rounded-card bg-grouped p-3">
                    <div className="glass rounded-card px-3 py-2 text-footnote text-secondary shadow-card">
                      {t("浮层控制预览 · 玻璃只用在内容之上")}
                    </div>
                  </div>
                </div>
                <Row
                  label={t("减少透明效果")}
                  hint={t("关闭玻璃模糊、改用纯色面板，低性能设备更流畅")}
                >
                  <Switch
                    checked={reduceTransparency}
                    onCheckedChange={toggleTransparency}
                    label={t("减少透明效果")}
                  />
                </Row>
                <Row
                  label={t("画布内嵌编辑")}
                  hint={t(
                    "从画布节点进入的编辑在右侧面板展开；关闭后回到全屏浮层",
                  )}
                >
                  <Switch
                    checked={canvasInline}
                    onCheckedChange={setCanvasInline}
                    label={t("画布内嵌编辑")}
                  />
                </Row>
                <Row label={t("界面语言")} hint={t("切换界面语言，立即生效")}>
                  <SegmentedControl
                    value={locale}
                    onValueChange={(v) => setLocale(v as typeof locale)}
                    label={t("界面语言")}
                    size="sm"
                    options={LOCALE_OPTIONS}
                  />
                </Row>
                <Row
                  label={t("界面模式")}
                  hint={t(
                    "简单模式只保留提示词、比例、风格与张数；专家模式显示负向词、队列与自定义尺寸",
                  )}
                >
                  <SegmentedControl
                    value={mode}
                    onValueChange={(v) => setMode(v as "simple" | "expert")}
                    label={t("界面模式")}
                    size="sm"
                    options={MODE_OPTIONS.map((o) => ({
                      ...o,
                      label: t(o.label),
                    }))}
                  />
                </Row>
              </Section>
            )}

            {section === "generation" && (
              <>
                <Section
                  title={t("默认生成参数")}
                  description={t("决定新对话里的比例、风格与张数")}
                >
                  <Row
                    label={t("当前参数")}
                    hint={t("以聊天页 Composer 里的设置为准")}
                  >
                    <span className="text-footnote text-tertiary">
                      {t("{{size}} · 质量 {{quality}} · {{n}} 张", {
                        size: sizeLabel(prefs.width, prefs.height),
                        quality: t(
                          qualityLabel(prefs.quality),
                          qualityLabel(prefs.quality),
                        ),
                        n: prefs.count,
                      })}
                    </span>
                  </Row>
                  <Row label={t("设为默认")}>
                    <Button
                      size="sm"
                      onClick={() =>
                        api
                          .setSetting("defaultParams", JSON.stringify(prefs))
                          .then(() => toast(t("已保存为默认参数")))
                          .catch((e) =>
                            toast(
                              t("保存默认参数失败：{{error}}", {
                                error: String(e),
                              }),
                              "error",
                            ),
                          )
                      }
                    >
                      {t("将当前设为默认")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={async () => {
                        const saved = await api.getSetting("defaultParams");
                        if (!saved) return;
                        try {
                          setPrefs(sanitizePrefs(JSON.parse(saved)));
                          toast(t("已恢复默认参数"));
                        } catch {
                          toast(t("默认参数损坏，无法恢复"), "error");
                        }
                      }}
                    >
                      {t("恢复默认")}
                    </Button>
                  </Row>
                </Section>
                <StylePresetsSection />
                <Section
                  title={t("智能蒙版")}
                  description={t("本地 AI 识别主体，离线运行，不上传图片")}
                >
                  <SmartMaskRow />
                </Section>
                <Section
                  title={t("队列")}
                  description={t("批量生成的启动行为与恢复策略")}
                >
                  <QueueAutoResumeRow />
                </Section>
                <ThinkingSection key={thinkingKey} />
              </>
            )}

            {section === "network" && <NetworkSection />}

            {section === "storage" && (
              <>
                <StorageSection dataDir={dataDir} />
                <Section
                  title={t("数据备份")}
                  description={t("导出后可迁移到另一台设备")}
                >
                  <Row label={t("导出全部配置")}>
                    <Button
                      size="sm"
                      onClick={() => doExport().catch(() => undefined)}
                    >
                      {t("导出配置")}
                    </Button>
                    <Button size="sm" onClick={() => fileRef.current?.click()}>
                      {t("导入配置")}
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
                    label={t("同时导出 API Key")}
                    hint={t("明文写入备份文件，仅用于本机迁移")}
                  >
                    <Switch
                      checked={includeKeys}
                      onCheckedChange={setIncludeKeys}
                      label={t("同时导出 API Key")}
                    />
                  </Row>
                  {(includeKeys || backupMsg) && (
                    <div className="space-y-1 px-3 pb-3">
                      {includeKeys && (
                        <p className="text-footnote text-danger">
                          {t("导出文件将包含明文密钥，请勿分享或上传。")}
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

            {section === "requests" && <RequestsSection />}

            {section === "diagnostics" && (
              <Section
                title={t("诊断日志")}
                description={t(
                  "诊断包包含近 7 天日志、应用版本与系统信息、服务商元信息与设置项；不含图片、提示词与任何 API Key。日志里可能带上游返回的错误信息，分享前请自行确认。",
                )}
              >
                <Row label={t("日志目录")}>
                  <span className="max-w-xs truncate text-footnote text-tertiary">
                    {logsDir}
                  </span>
                </Row>
                <Row label={t("导出诊断包")}>
                  <Button
                    size="sm"
                    loading={diagBusy}
                    onClick={() => doExportDiagnostics().catch(() => undefined)}
                  >
                    {t("导出诊断包")}
                  </Button>
                  {diagPath && (
                    <Button
                      size="sm"
                      onClick={() =>
                        revealItemInDir(diagPath).catch((e) =>
                          toast(
                            t("打开目录失败：{{error}}", { error: String(e) }),
                            "error",
                          ),
                        )
                      }
                    >
                      {t("打开所在目录")}
                    </Button>
                  )}
                </Row>
                {diagPath && (
                  <div className="px-4 pb-3 text-footnote text-tertiary">
                    {t("已导出：{{path}}", { path: diagPath })}
                  </div>
                )}
              </Section>
            )}

            {section === "about" && <AboutSection />}

            {section === "shortcuts" &&
              SHORTCUT_GROUPS.map((group) => (
                <Section
                  key={group}
                  title={t(group)}
                  description={
                    group === "全局" ? t("在任何页面都可用") : undefined
                  }
                >
                  {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                    <Row
                      key={s.keys}
                      label={
                        <span className="text-callout text-secondary">
                          {t(s.label, s.label)}
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
