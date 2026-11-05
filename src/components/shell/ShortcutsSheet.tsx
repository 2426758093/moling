import { useAppStore } from "../../stores/appStore";
import { SHORTCUTS } from "../../lib/shortcuts";
import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/Kbd";

const GROUPS = ["全局", "画布", "列表"] as const;

export default function ShortcutsSheet() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="快捷键"
      description="输入框聚焦时，只有带 Ctrl 的组合键会触发全局命令。"
      size="md"
    >
      <div className="space-y-5 pb-3">
        {GROUPS.map((group) => (
          <section key={group} className="space-y-1">
            <h3 className="px-1 text-subhead text-tertiary">{group}</h3>
            <div className="overflow-hidden rounded-card bg-sunken">
              {SHORTCUTS.filter((s) => s.group === group).map((item) => (
                <div
                  key={item.keys}
                  className="flex min-h-9 items-center justify-between gap-4 px-3 py-1.5 text-callout text-secondary after:pointer-events-none"
                >
                  <span>{item.label}</span>
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
