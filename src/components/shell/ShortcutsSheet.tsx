import { useTranslation } from "react-i18next";
import type { ParseKeysWithoutVariables } from "i18next";
import { useAppStore } from "../../stores/appStore";
import { SHORTCUTS } from "../../lib/shortcuts";
import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/Kbd";

const GROUPS = ["全局", "画布", "列表"] as const;

/// 清单里的 label 是中文原文，也就是词典 key；清单字段声明为普通 string，
/// 这里显式收窄回 key 联合，让 t() 的严格类型仍然生效。
const shortcutKey = (label: string) => label as ParseKeysWithoutVariables;

export default function ShortcutsSheet() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={t("快捷键")}
      description={t("输入框聚焦时，只有带 Ctrl 的组合键会触发全局命令。")}
      size="md"
    >
      <div className="space-y-5 pb-3">
        {GROUPS.map((group) => (
          <section key={group} className="space-y-1">
            <h3 className="px-1 text-subhead text-tertiary">{t(group)}</h3>
            <div className="overflow-hidden rounded-card bg-sunken">
              {SHORTCUTS.filter((s) => s.group === group).map((item) => (
                <div
                  key={item.keys}
                  className="flex min-h-9 items-center justify-between gap-4 px-3 py-1.5 text-callout text-secondary after:pointer-events-none"
                >
                  <span>{t(shortcutKey(item.label))}</span>
                  <Kbd>{item.keys}</Kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
