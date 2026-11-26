import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PromptFavorite } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Input } from "../../ui/Field";
import { IconTrash } from "../../Icons";

export default function FavoritesTab({
  draft,
  totalCount,
  visibleFavorites,
  allTags,
  tagFilter,
  tags,
  onTagFilterChange,
  onTagsChange,
  onAdd,
  onRemove,
  onExport,
  onImport,
  onApply,
}: {
  draft: string;
  totalCount: number;
  visibleFavorites: PromptFavorite[];
  allTags: string[];
  tagFilter: string;
  tags: string;
  onTagFilterChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation();
  const favFileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <Input
          value={tags}
          onChange={(e) => onTagsChange(e.target.value)}
          placeholder={t("标签，逗号分隔（可选）")}
          aria-label={t("收藏标签")}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!draft.trim()}
          onClick={onAdd}
        >
          {t("收藏当前")}
        </Button>
      </div>
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => onTagFilterChange("")}
            className={`pressable rounded-pill px-2 py-0.5 text-caption transition-colors ${
              tagFilter === ""
                ? "bg-accent-soft text-accent-text"
                : "bg-fill text-tertiary hover:text-secondary"
            }`}
          >
            {t("全部")}
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => onTagFilterChange(tagFilter === tag ? "" : tag)}
              className={`pressable rounded-pill px-2 py-0.5 text-caption transition-colors ${
                tagFilter === tag
                  ? "bg-accent-soft text-accent-text"
                  : "bg-fill text-tertiary hover:text-secondary"
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {visibleFavorites.map((f) => (
          <div
            key={f.id}
            className="group flex items-start gap-2 rounded-btn border border-line px-3 py-2"
          >
            <button
              onClick={() => onApply(f.text)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="line-clamp-2 text-footnote leading-snug text-primary">
                {f.text}
              </div>
              {f.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {f.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-pill bg-fill px-1.5 py-0.5 text-caption text-tertiary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
            <IconButton
              label={t("删除收藏：{{preview}}", {
                preview: f.text.slice(0, 20),
              })}
              icon={<IconTrash size={13} />}
              size="sm"
              tooltip={false}
              className="text-tertiary hover:text-danger"
              onClick={() => onRemove(f.id)}
            />
          </div>
        ))}
        {visibleFavorites.length === 0 && (
          <div className="py-4 text-center text-footnote text-tertiary">
            {totalCount === 0
              ? t("还没有收藏，先在输入框写好提示词")
              : t("该标签下没有收藏")}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-line pt-2.5">
        <Button size="sm" onClick={onExport}>
          {t("导出 JSON")}
        </Button>
        <Button size="sm" onClick={() => favFileRef.current?.click()}>
          {t("导入 JSON")}
        </Button>
        <input
          ref={favFileRef}
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
