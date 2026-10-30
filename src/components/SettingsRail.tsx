import { useEffect, useState } from "react";
import { useProviderStore } from "../stores/providerStore";
import { useAppStore } from "../stores/appStore";
import { api, ThinkingConfig } from "../lib/api";
import { toast } from "../lib/notify";
import { useCompact } from "../hooks/useMediaQuery";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { cn } from "./ui/cn";
import { IconChevron, IconBrain } from "./Icons";

export default function SettingsRail() {
  const [collapsed, setCollapsed] = useState(false);
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const setDefaultProvider = useProviderStore((s) => s.setDefaultProvider);
  const saveProvider = useProviderStore((s) => s.save);
  const setView = useAppStore((s) => s.setView);
  const [thinking, setThinking] = useState<ThinkingConfig | null>(null);
  const compact = useCompact();

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
      toast(`保存思考模型配置失败：${String(e)}`, "error");
    }
  };

  return (
    <aside
      className={cn(
        "glass flex shrink-0 flex-col overflow-hidden transition-[width] duration-300 ease-ios",
        collapsed ? "w-14" : compact ? "w-50" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center",
          collapsed ? "justify-center" : "justify-between px-4",
        )}
      >
        {!collapsed && (
          <span className="text-caption text-tertiary">生成设置</span>
        )}
        <IconButton
          label={collapsed ? "展开设置栏" : "折叠设置栏"}
          size="sm"
          tooltip={false}
          icon={
            <IconChevron direction={collapsed ? "left" : "right"} size={14} />
          }
          onClick={() => setCollapsed((v) => !v)}
        />
      </div>

      <div
        className={cn(
          "scroll-edge min-h-0 flex-1 space-y-4 overflow-y-auto pb-4",
          collapsed ? "px-2" : "px-4",
        )}
      >
        {!collapsed && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-tertiary">绘图服务商</span>
              <Select
                label="绘图服务商"
                value={defaultProviderId ? String(defaultProviderId) : ""}
                placeholder="（未选择）"
                onValueChange={(v) =>
                  setDefaultProvider(v === "" ? null : Number(v))
                }
                options={[
                  { value: "", label: "（未选择）" },
                  ...providers.map((p) => ({
                    value: String(p.provider.id),
                    label: p.provider.name,
                  })),
                ]}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-tertiary">绘图模型</span>
              <Select
                label="绘图模型"
                value={defaultItem?.provider.defaultModel ?? ""}
                placeholder="（未选择）"
                disabled={!defaultItem || models.length === 0}
                onValueChange={(v) => {
                  if (!defaultItem) return;
                  saveProvider({
                    ...defaultItem.provider,
                    defaultModel: v,
                  }).catch((err) =>
                    toast(`保存默认模型失败：${String(err)}`, "error"),
                  );
                }}
                options={[
                  { value: "", label: "（未选择）" },
                  ...models.map((m) => ({ value: m, label: m })),
                ]}
              />
            </div>

            {/* 思考模型：内容层材质（不透明卡片），不是玻璃 */}
            <div className="rounded-card border border-line bg-elevated p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-accent">
                    <IconBrain size={16} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-callout font-medium text-primary">
                      思考模型
                    </div>
                    <div className="mt-0.5 text-footnote text-tertiary">
                      {thinking?.enabled
                        ? `已启用 · ${thinking.model || "未选模型"}`
                        : "生成前理解意图"}
                    </div>
                  </div>
                </div>
                <Switch
                  checked={Boolean(thinking?.enabled)}
                  onCheckedChange={() => void toggleThinking()}
                  label="启用思考模型"
                />
              </div>
              <Button
                size="sm"
                block
                className="mt-3"
                onClick={() => setView("settings")}
              >
                配置思考模型…
              </Button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
