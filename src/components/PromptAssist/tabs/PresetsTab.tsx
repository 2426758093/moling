import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowPreset } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Input } from "../../ui/Field";
import { IconTrash } from "../../Icons";
import { presetRefSummary } from "../types";

export default function PresetsTab({
  presets,
  name,
  busy,
  onNameChange,
  onSave,
  onApply,
  onRemove,
  onExport,
  onImport,
}: {
  presets: WorkflowPreset[];
  name: string;
  busy: boolean;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onApply: (preset: WorkflowPreset) => void;
  onRemove: (id: number) => void;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const { t } = useTranslation();
  const presetFileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t("预设名称")}
          aria-label={t("预设名称")}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!name.trim() || busy}
          onClick={onSave}
        >
          {busy ? t("保存中…") : t("保存当前")}
        </Button>
      </div>
      <div className="text-caption leading-snug text-tertiary">
        {t(
          "保存草稿、负向词、尺寸 / 比例 / 风格 / 张数，以及当前参考图（最多 4 张）",
        )}
      </div>
      <div className="space-y-1.5">
        {presets.map((p) => (
          <div
            key={p.id}
            className="group flex items-center gap-2 rounded-btn border border-line px-3 py-2"
          >
            <button
              onClick={() => onApply(p)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-subhead font-medium text-primary">
                  {p.name}
                </span>
                <span className="shrink-0 text-caption text-tertiary">
                  {presetRefSummary(p, t)}
                </span>
              </div>
              <div className="mt-0.5 line-clamp-1 text-footnote text-tertiary">
                {p.prompt || t("（无提示词）")}
              </div>
            </button>
            <IconButton
              label={t("删除预设 {{name}}", { name: p.name })}
              icon={<IconTrash size={13} />}
              size="sm"
              tooltip={false}
              className="text-tertiary hover:text-danger"
              onClick={() => onRemove(p.id)}
            />
          </div>
        ))}
        {presets.length === 0 && (
          <div className="py-4 text-center text-footnote text-tertiary">
            {t("还没有预设，命名后点击「保存当前」")}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-line pt-2.5">
        <Button size="sm" onClick={onExport}>
          {t("导出 JSON")}
        </Button>
        <Button size="sm" onClick={() => presetFileRef.current?.click()}>
          {t("导入 JSON")}
        </Button>
        <input
          ref={presetFileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
