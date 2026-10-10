import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useProviderStore } from "../stores/providerStore";
import { useAppStore } from "../stores/appStore";
import { api, ThinkingConfig } from "../lib/api";
import { toast } from "../lib/notify";
import { IconChevron, IconPalette, IconBrain } from "./Icons";

export default function SettingsRail() {
  const [collapsed, setCollapsed] = useState(false);
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const setDefaultProvider = useProviderStore((s) => s.setDefaultProvider);
  const saveProvider = useProviderStore((s) => s.save);
  const setView = useAppStore((s) => s.setView);
  const [thinking, setThinking] = useState<ThinkingConfig | null>(null);

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
    <motion.aside
      animate={{ width: collapsed ? 52 : 240 }}
      transition={{ type: "spring", stiffness: 400, damping: 36 }}
      className="bg-glass flex shrink-0 flex-col overflow-hidden border-l border-theme"
    >
      <div className="flex h-[52px] shrink-0 items-center justify-between px-3">
        {!collapsed && (
          <span className="text-[11px] font-medium tracking-wide text-tertiary">
            生成设置
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "展开" : "折叠"}
          className="pressable rounded-md p-1 text-tertiary transition-colors hover:bg-hover hover:text-secondary"
        >
          <IconChevron direction={collapsed ? "left" : "right"} size={14} />
        </button>
      </div>

      <div
        className={`min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4 ${
          collapsed ? "px-2" : ""
        }`}
      >
        {!collapsed ? (
          <>
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
                绘图服务商
              </div>
              <select
                value={defaultProviderId ?? ""}
                onChange={(e) =>
                  setDefaultProvider(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                className="w-full rounded-[10px] border border-theme bg-transparent px-2.5 py-[7px] text-[13px] outline-none transition-colors focus:border-accent"
              >
                <option value="">（未选择）</option>
                {providers.map((p) => (
                  <option key={p.provider.id} value={p.provider.id!}>
                    {p.provider.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
                绘图模型
              </div>
              <select
                value={defaultItem?.provider.defaultModel ?? ""}
                onChange={(e) => {
                  if (!defaultItem) return;
                  saveProvider({
                    ...defaultItem.provider,
                    defaultModel: e.target.value,
                  }).catch((err) =>
                    toast(`保存默认模型失败：${String(err)}`, "error"),
                  );
                }}
                className="w-full rounded-[10px] border border-theme bg-transparent px-2.5 py-[7px] text-[13px] outline-none transition-colors focus:border-accent"
              >
                <option value="">（未选择）</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            {/* iOS 开关组样式 */}
            <div className="rounded-[var(--radius-card)] border border-theme bg-elevated p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="text-accent">
                    <IconBrain size={17} />
                  </span>
                  <div>
                    <div className="text-[13px] font-medium text-primary">
                      思考模型
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-tertiary">
                      {thinking?.enabled
                        ? `已启用 · ${thinking.model || "未选模型"}`
                        : "生成前理解意图"}
                    </div>
                  </div>
                </div>
                <button
                  onClick={toggleThinking}
                  className={`relative h-[26px] w-[44px] rounded-full transition-colors duration-200 ${
                    thinking?.enabled ? "bg-success" : "bg-sunken"
                  }`}
                >
                  <span
                    className={`absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all duration-200 ease-out ${
                      thinking?.enabled ? "left-[20px]" : "left-[2px]"
                    }`}
                  />
                </button>
              </div>
              <button
                onClick={() => setView("settings")}
                className="pressable mt-3 w-full rounded-[10px] border border-theme py-[7px] text-[12px] text-secondary transition-colors hover:bg-hover"
              >
                配置思考模型…
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-5 pt-2 text-tertiary">
            <IconPalette size={17} />
            <IconBrain size={17} />
          </div>
        )}
      </div>
    </motion.aside>
  );
}
