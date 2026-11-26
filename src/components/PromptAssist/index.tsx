import { useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { DUR, EASE } from "../../lib/motion";
import { useChatStore } from "../../stores/chatStore";
import { IconButton } from "../ui/IconButton";
import { SegmentedControl } from "../ui/SegmentedControl";
import { IconClose } from "../Icons";
import { TABS, type TabId } from "./types";
import {
  useFavorites,
  useInspiration,
  useOptimize,
  usePresets,
  usePromptAssetsBootstrap,
  useReverse,
  useTemplates,
  useTranslate,
} from "./controller";
import OptimizeTab from "./tabs/OptimizeTab";
import TemplateTab from "./tabs/TemplateTab";
import InspirationTab from "./tabs/InspirationTab";
import ReverseTab from "./tabs/ReverseTab";
import FavoritesTab from "./tabs/FavoritesTab";
import PresetsTab from "./tabs/PresetsTab";
import TranslateTab from "./tabs/TranslateTab";

export default function PromptAssist({
  draft,
  onClose,
}: {
  draft: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("templates");
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);

  usePromptAssetsBootstrap();
  const templates = useTemplates();
  const inspiration = useInspiration();
  const reverse = useReverse();
  const favorites = useFavorites(draft);
  const presets = usePresets(draft, onClose);
  const optimize = useOptimize(draft);
  const translate = useTranslate(draft);

  const applyText = (text: string) => {
    setDraftPrompt(text);
    onClose();
  };

  return (
    <motion.div
      data-assist-panel
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: DUR.base, ease: EASE.ios }}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-pop border border-line bg-elevated shadow-sheet"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 overflow-x-auto">
          <SegmentedControl
            value={tab}
            onValueChange={setTab}
            label={t("提示词助手分区")}
            size="sm"
            options={TABS.map((item) => ({
              value: item.id,
              label: t(item.label),
            }))}
          />
        </div>
        <IconButton
          label={t("关闭提示词助手")}
          icon={<IconClose size={14} />}
          size="sm"
          onClick={onClose}
        />
      </div>

      <div className="max-h-72 overflow-y-auto p-3">
        {tab === "optimize" && (
          <OptimizeTab
            draft={draft}
            busy={optimize.busy}
            error={optimize.error}
            result={optimize.result}
            onResultChange={optimize.setResult}
            onOptimize={() => void optimize.run()}
            onApply={applyText}
          />
        )}

        {tab === "templates" && (
          <TemplateTab
            builtin={templates.builtin}
            custom={templates.custom}
            newTitle={templates.newTitle}
            newText={templates.newText}
            onTitleChange={templates.setNewTitle}
            onTextChange={templates.setNewText}
            onAdd={() => void templates.addCustom()}
            onRemove={(id) => void templates.removeCustom(id)}
            onApply={applyText}
          />
        )}

        {tab === "inspire" && (
          <InspirationTab
            inspiration={inspiration.inspiration}
            onRoll={inspiration.roll}
            onApply={applyText}
          />
        )}

        {tab === "reverse" && (
          <ReverseTab
            img={reverse.img}
            busy={reverse.busy}
            error={reverse.error}
            result={reverse.result}
            onResultChange={reverse.setResult}
            onFile={(file) => void reverse.run(file)}
            onApply={applyText}
          />
        )}

        {tab === "favorites" && (
          <FavoritesTab
            draft={draft}
            totalCount={favorites.totalCount}
            visibleFavorites={favorites.visibleFavorites}
            allTags={favorites.allTags}
            tagFilter={favorites.favTagFilter}
            tags={favorites.favTags}
            onTagFilterChange={favorites.setFavTagFilter}
            onTagsChange={favorites.setFavTags}
            onAdd={() => void favorites.addFavorite()}
            onRemove={favorites.removeFavorite}
            onExport={favorites.exportFavorites}
            onImport={(file) => void favorites.importFavorites(file)}
            onApply={applyText}
          />
        )}

        {tab === "presets" && (
          <PresetsTab
            presets={presets.presets}
            name={presets.presetName}
            busy={presets.presetBusy}
            onNameChange={presets.setPresetName}
            onSave={() => void presets.saveCurrentPreset()}
            onApply={(preset) => void presets.applyPreset(preset)}
            onRemove={presets.removePreset}
            onExport={() => void presets.exportPresets()}
            onImport={(file) => void presets.importPresets(file)}
          />
        )}

        {tab === "translate" && (
          <TranslateTab
            draft={draft}
            busy={translate.busy}
            error={translate.error}
            result={translate.result}
            onResultChange={translate.setResult}
            onTranslate={() => void translate.run()}
            onApply={applyText}
          />
        )}
      </div>
    </motion.div>
  );
}
