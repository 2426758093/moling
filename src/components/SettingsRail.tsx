import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useProviderStore } from "../stores/providerStore";
import { useAppStore } from "../stores/appStore";
import { api, ThinkingConfig } from "../lib/api";
import { toast } from "../lib/notify";
import { useCompact } from "../hooks/useMediaQuery";
import { useMotionTokens } from "../lib/useMotion";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { IconChevron, IconBrain } from "./Icons";

export default function SettingsRail() {
  const { t } = useTranslation();
  const compact = useCompact();
  const [collapsed, setCollapsed] = useState(compact);
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const setDefaultProvider = useProviderStore((s) => s.setDefaultProvider);
  const saveProvider = useProviderStore((s) => s.save);
  const setView = useAppStore((s) => s.setView);
  const [thinking, setThinking] = useState<ThinkingConfig | null>(null);
  const motionTokens = useMotionTokens();

  useEffect(() => {
    api
      .getThinkingConfig()
      .then(setThinking)
      .catch(() => undefined);
  }, []);

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

  return (
    <div className="relative shrink-0">
      <motion.aside
        animate={{ width: collapsed ? 0 : 240 }}
        transition={motionTokens.spring("gentle")}
        aria-hidden={collapsed}
        className="glass my-2 mr-2 flex flex-col overflow-hidden rounded-panel"
      >
        <div className="flex h-12 w-60 shrink-0 items-center justify-between px-4">
          <span className="text-caption text-tertiary uppercase">
            {t("生成设置")}
          </span>
          <IconButton
            label={t("折叠设置栏")}
            size="sm"
            tooltip={false}
            icon={<IconChevron direction="right" size={14} />}
            onClick={() => setCollapsed(true)}
          />
        </div>

        <div className="scroll-edge min-h-0 w-60 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
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
            <span className="text-caption text-tertiary">{t("绘图模型")}</span>
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
                    t("保存默认模型失败：{{error}}", { error: String(err) }),
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

          {/* 思考模型：内容层材质（不透明卡片），不是玻璃 */}
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
        </div>
      </motion.aside>

      {collapsed && (
        <button
          type="button"
          aria-label={t("展开生成设置")}
          onClick={() => setCollapsed(false)}
          className="glass pressable absolute right-2 top-2 z-20 flex size-8 items-center justify-center rounded-pill text-secondary shadow-pop hover:text-primary"
        >
          <IconBrain size={14} />
        </button>
      )}
    </div>
  );
}
