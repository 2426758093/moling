import { useTranslation } from "react-i18next";
import type { PromptTemplate } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Input, Textarea } from "../../ui/Field";
import { IconTrash } from "../../Icons";

export default function TemplateTab({
  builtin,
  custom,
  newTitle,
  newText,
  onTitleChange,
  onTextChange,
  onAdd,
  onRemove,
  onApply,
}: {
  builtin: PromptTemplate[];
  custom: PromptTemplate[];
  newTitle: string;
  newText: string;
  onTitleChange: (value: string) => void;
  onTextChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {builtin.map((tpl) => (
          <button
            key={tpl.id}
            onClick={() => onApply(tpl.text)}
            className="pressable rounded-btn border border-line px-3 py-2 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-soft"
          >
            <div className="text-subhead font-medium text-primary">
              {tpl.title}
            </div>
            <div className="mt-0.5 line-clamp-2 text-footnote leading-snug text-tertiary">
              {tpl.text}
            </div>
          </button>
        ))}
      </div>
      {custom.length > 0 && (
        <div className="space-y-1.5 border-t border-line pt-2.5">
          {custom.map((tpl) => (
            <div
              key={tpl.id}
              className="group flex items-center gap-2 rounded-btn border border-line px-3 py-2"
            >
              <button
                onClick={() => onApply(tpl.text)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="text-subhead font-medium text-primary">
                  {tpl.title}
                </div>
                <div className="mt-0.5 truncate text-footnote text-tertiary">
                  {tpl.text}
                </div>
              </button>
              <IconButton
                label={t("删除模板 {{name}}", { name: tpl.title })}
                icon={<IconTrash size={13} />}
                size="sm"
                tooltip={false}
                className="text-tertiary hover:text-danger"
                onClick={() => onRemove(tpl.id)}
              />
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1.5 border-t border-line pt-2.5">
        <Input
          value={newTitle}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder={t("模板名称")}
          aria-label={t("模板名称")}
        />
        <Textarea
          value={newText}
          onChange={(e) => onTextChange(e.target.value)}
          rows={2}
          compact
          placeholder={t("模板内容（提示词，{subject} 可作占位）")}
          aria-label={t("模板内容")}
        />
        <Button
          size="sm"
          block
          disabled={!newTitle.trim() || !newText.trim()}
          onClick={onAdd}
        >
          {t("保存为自定义模板")}
        </Button>
      </div>
    </div>
  );
}
