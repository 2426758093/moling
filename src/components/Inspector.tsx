import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProviderStore } from "../stores/providerStore";
import { useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import { api, type ThinkingConfig } from "../lib/api";
import { toast } from "../lib/notify";
import { useCompact } from "../hooks/useMediaQuery";
import { useLayoutStore } from "../stores/layoutStore";
import { maxReferenceImages } from "../lib/useModelCaps";
import { FOCUS_COMPOSER_EVENT, OPEN_ASSIST_EVENT } from "../lib/commands";
import { REFERENCE_ROLES } from "../lib/types";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Switch } from "./ui/Switch";
import { IconBrain, IconImage } from "./Icons";

type Tab = "params" | "refs" | "assist";

const ROLE_LABEL = {
  composition: "构图参考",
  style: "风格参考",
  face: "人脸参考",
  element: "元素参考",
} as const;

/// 右侧检查器：参数 / 参考 / 助手三页签。
/// 只出现在创作页；其它工作区把自己的上下文放在各自的舞台或浮层里。
export default function Inspector() {
  const { t } = useTranslation();
  const compact = useCompact();
  const [tab, setTab] = useState<Tab>("params");
  const inspectorWidth = useLayoutStore((s) => s.inspectorWidth);

  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const setDefaultProvider = useProviderStore((s) => s.setDefaultProvider);
  const saveProvider = useProviderStore((s) => s.save);

  const setView = useAppStore((s) => s.setView);

  const attachments = useChatStore((s) => s.attachments);

  const [thinking, setThinking] = useState<ThinkingConfig | null>(null);

  useEffect(() => {
    api
      .getThinkingConfig()
      .then(setThinking)
      .catch(() => undefined);
  }, []);

  if (compact) return null;

  const defaultItem = providers.find(
    (p) => p.provider.id === defaultProviderId,
  );
  const models: string[] = (() => {
    try {
      return defaultItem?.provider.modelsJson
        ? JSON.parse(defaultItem.provider.modelsJson)
        : [];
    } catch {
      return [];
    }
  })();

  const toggleThinking = async () => {
    if (!thinking) return;
    try {
      const next = { ...thinking, enabled: !thinking.enabled };
      setThinking(await api.saveThinkingConfig(next));
    } catch (e) {
      toast(
        t("保存思考模型配置失败：{{error}}", { error: String(e) }),
        "error",
      );
    }
  };

  const openAssist = () => {
    window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT));
    window.dispatchEvent(new Event(OPEN_ASSIST_EVENT));
  };

  const addReference = () => {
    window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT));
  };

  return (
    <aside
      aria-label={t("生成参数")}
      className="flex shrink-0 flex-col border-l border-separator bg-window"
      style={{ width: inspectorWidth }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <SegmentedControl<Tab>
          value={tab}
          onValueChange={setTab}
          label={t("检查器分区")}
          size="sm"
          block
          options={[
            { value: "params", label: t("参数") },
            { value: "refs", label: t("参考") },
            { value: "assist", label: t("助手") },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {tab === "params" && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-tertiary">
                {t("绘图服务商")}
              </span>
              <Select
                label={t("绘图服务商")}
                value={defaultProviderId ? String(defaultProviderId) : ""}
                placeholder={t("（未选择）")}
                onValueChange={(v) =>
                  setDefaultProvider(v === "" ? null : Number(v))
                }
                options={[
                  { value: "", label: t("（未选择）") },
                  ...providers.map((p) => ({
                    value: String(p.provider.id),
                    label: p.provider.name,
                  })),
                ]}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-tertiary">
                {t("绘图模型")}
              </span>
              <Select
                label={t("绘图模型")}
                value={defaultItem?.provider.defaultModel ?? ""}
                placeholder={t("（未选择）")}
                disabled={!defaultItem || models.length === 0}
                onValueChange={(v) => {
                  if (!defaultItem) return;
                  saveProvider({
                    ...defaultItem.provider,
                    defaultModel: v,
                  }).catch((err) =>
                    toast(
                      t("保存默认模型失败：{{error}}", {
                        error: String(err),
                      }),
                      "error",
                    ),
                  );
                }}
                options={[
                  { value: "", label: t("（未选择）") },
                  ...models.map((m) => ({ value: m, label: m })),
                ]}
              />
            </div>

            <div className="rounded-card bg-elevated p-3 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-accent">
                    <IconBrain size={16} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-callout font-medium text-primary">
                      {t("思考模型")}
                    </div>
                    <div className="mt-0.5 text-footnote text-tertiary">
                      {thinking?.enabled
                        ? t("已启用 · {{model}}", {
                            model: thinking.model || t("未选模型"),
                          })
                        : t("生成前理解意图")}
                    </div>
                  </div>
                </div>
                <Switch
                  checked={Boolean(thinking?.enabled)}
                  onCheckedChange={() => void toggleThinking()}
                  label={t("启用思考模型")}
                />
              </div>
              <Button
                size="sm"
                block
                className="mt-3"
                onClick={() => setView("settings")}
              >
                {t("配置思考模型…")}
              </Button>
            </div>
          </>
        )}

        {tab === "refs" && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-caption text-tertiary">{t("参考图")}</span>
              <span className="text-caption tabular text-quaternary">
                {attachments.length} / {maxReferenceImages()}
              </span>
            </div>
            {attachments.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-card bg-elevated px-4 py-6 text-center shadow-card">
                <span className="text-tertiary">
                  <IconImage size={20} />
                </span>
                <p className="text-footnote text-tertiary">{t("暂无参考图")}</p>
                <Button size="sm" onClick={addReference}>
                  {t("去落笔坞添加")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {attachments.map((a) => {
                  const role = REFERENCE_ROLES.find((r) => r.id === a.role);
                  return (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 rounded-card bg-elevated p-2 shadow-card"
                    >
                      <span className="h-10 w-10 shrink-0 overflow-hidden rounded-chip border border-line">
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="h-full w-full object-cover"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-footnote text-primary">
                          {a.name}
                        </span>
                        <span className="block text-caption text-quaternary">
                          {role && role.id in ROLE_LABEL
                            ? t(ROLE_LABEL[role.id as keyof typeof ROLE_LABEL])
                            : t("参考图")}
                          {typeof a.strength === "number"
                            ? ` · ${a.strength}%`
                            : ""}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === "assist" && (
          <div className="flex flex-col gap-3">
            <div className="rounded-card bg-elevated p-3 shadow-card">
              <div className="text-callout font-medium text-primary">
                {t("提示词助手")}
              </div>
              <p className="mt-1 text-footnote leading-6 text-tertiary">
                {t("模板、灵感、反推、优化与翻译都在落笔坞的提示词助手里。")}
              </p>
            </div>
            <Button block variant="primary" onClick={openAssist}>
              {t("打开提示词助手")}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
