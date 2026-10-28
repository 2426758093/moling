import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  api,
  PromptTemplate,
  AdapterError,
  adapterErrorTitle,
} from "../lib/api";
import { readFileAsDataUrl } from "../lib/file";
import { useChatStore } from "../stores/chatStore";
import { IconSparkle, IconImage, IconClose, IconTrash } from "./Icons";
import SafeImg from "./SafeImg";

const SUBJECTS = [
  "一只橘猫",
  "古风少女",
  "未来机甲",
  "山间古寺",
  "蒸汽火车",
  "深海鲸鱼",
  "竹林剑客",
  "玻璃花房",
  "沙漠旅人",
  "云端城市",
];
const SCENES = [
  "在暴雨夜",
  "于晨光之中",
  "漂浮在太空",
  "被樱花环绕",
  "在霓虹灯下",
  "于云海之上",
  "在古老图书馆",
  "伴着极光",
  "在无人海滩",
  "于金色麦田",
];
const STYLES = [
  "赛博朋克",
  "水彩画",
  "吉卜力动画",
  "写实摄影",
  "浮世绘",
  "低多边形 3D",
  "黑白胶片",
  "像素艺术",
  "油画",
  "概念设计稿",
];
const LIGHTS = [
  "逆光轮廓光",
  "柔和的窗光",
  "戏剧化聚光",
  "月光冷色调",
  "暖色黄昏光",
  "霓虹反射光",
  "薄雾散射光",
  "闪电瞬间",
  "烛光摇曳",
  "正午硬光",
];

const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

const TABS = [
  { id: "templates", label: "模板" },
  { id: "inspire", label: "灵感" },
  { id: "reverse", label: "反推" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function rollInspiration(): string {
  return `${pick(SUBJECTS)}${pick(SCENES)}，${pick(STYLES)}风格，${pick(LIGHTS)}`;
}

export default function PromptAssist({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>("templates");
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);

  // 模板
  const [builtin, setBuiltin] = useState<PromptTemplate[]>([]);
  const [custom, setCustom] = useState<PromptTemplate[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");

  // 灵感
  const [inspiration, setInspiration] = useState(rollInspiration);

  // 反推
  const fileRef = useRef<HTMLInputElement>(null);
  const [reverseImg, setReverseImg] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState<AdapterError | null>(null);
  const [reverseResult, setReverseResult] = useState("");

  useEffect(() => {
    api
      .getPromptTemplates()
      .then((r) => {
        setBuiltin(r.builtin);
        setCustom(r.custom);
      })
      .catch(() => undefined);
  }, []);

  const applyTemplate = (t: PromptTemplate) => {
    setDraftPrompt(t.text);
    onClose();
  };

  const addCustom = async () => {
    if (!newTitle.trim() || !newText.trim()) return;
    const next = [
      ...custom,
      {
        id: `c_${Date.now()}`,
        title: newTitle.trim(),
        text: newText.trim(),
      },
    ];
    setCustom(next);
    await api.savePromptTemplates(next).catch(() => undefined);
    setNewTitle("");
    setNewText("");
  };

  const removeCustom = async (id: string) => {
    const next = custom.filter((c) => c.id !== id);
    setCustom(next);
    await api.savePromptTemplates(next).catch(() => undefined);
  };

  const doReverse = async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    setReverseImg(dataUrl);
    setReverseBusy(true);
    setReverseError(null);
    setReverseResult("");
    try {
      const r = await api.reversePrompt(dataUrl);
      if (r.ok && r.prompt) {
        setReverseResult(r.prompt);
      } else if (r.error) {
        setReverseError(r.error);
      }
    } catch (e) {
      setReverseError({ type: "other", message: String(e) });
    } finally {
      setReverseBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.97 }}
      transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
      className="bg-glass absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-[var(--radius-pop)] border border-theme shadow-pop"
    >
      <div className="flex items-center justify-between border-b border-theme px-4 py-2.5">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`pressable rounded-full px-3 py-1 text-[12px] transition-colors duration-150 ${
                tab === t.id
                  ? "bg-accent text-white"
                  : "text-tertiary hover:bg-hover hover:text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="pressable rounded-full p-1 text-tertiary transition-colors hover:bg-hover"
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="max-h-72 overflow-y-auto p-3">
        {tab === "templates" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {builtin.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t)}
                  className="pressable rounded-[10px] border border-theme px-3 py-2 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-soft"
                >
                  <div className="text-[12px] font-medium text-primary">
                    {t.title}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-tertiary">
                    {t.text}
                  </div>
                </button>
              ))}
            </div>
            {custom.length > 0 && (
              <div className="space-y-1.5 border-t border-theme pt-2.5">
                {custom.map((t) => (
                  <div
                    key={t.id}
                    className="group flex items-center gap-2 rounded-[10px] border border-theme px-3 py-2"
                  >
                    <button
                      onClick={() => applyTemplate(t)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="text-[12px] font-medium text-primary">
                        {t.title}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-tertiary">
                        {t.text}
                      </div>
                    </button>
                    <button
                      onClick={() => removeCustom(t.id)}
                      className="pressable rounded-md p-1 text-tertiary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5 border-t border-theme pt-2.5">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="模板名称"
                className="w-full rounded-[8px] border border-theme bg-transparent px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
              />
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                rows={2}
                placeholder="模板内容（提示词，{subject} 可作占位）"
                className="w-full resize-none rounded-[8px] border border-theme bg-transparent px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
              />
              <button
                onClick={addCustom}
                disabled={!newTitle.trim() || !newText.trim()}
                className="pressable w-full rounded-[8px] border border-theme py-1.5 text-[12px] text-secondary transition-opacity disabled:opacity-40"
              >
                保存为自定义模板
              </button>
            </div>
          </div>
        )}

        {tab === "inspire" && (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="w-full rounded-[10px] bg-elevated px-4 py-3 text-center text-[13px] leading-relaxed text-primary">
              {inspiration}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setInspiration(rollInspiration())}
                className="pressable flex items-center gap-1.5 rounded-[10px] border border-theme px-3 py-1.5 text-[12px] text-secondary"
              >
                <IconSparkle size={13} />
                再掷一次
              </button>
              <button
                onClick={() => {
                  setDraftPrompt(inspiration);
                  onClose();
                }}
                className="pressable rounded-[10px] bg-accent px-3 py-1.5 text-[12px] text-white"
              >
                使用这条
              </button>
            </div>
          </div>
        )}

        {tab === "reverse" && (
          <div className="space-y-2.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doReverse(f);
                e.target.value = "";
              }}
            />
            {!reverseImg ? (
              <button
                onClick={() => fileRef.current?.click()}
                className="pressable flex w-full flex-col items-center gap-2 rounded-[10px] border border-dashed border-theme py-6 text-tertiary"
              >
                <IconImage size={22} strokeWidth={1.4} />
                <span className="text-[12px]">上传图片，反推绘制提示词</span>
              </button>
            ) : (
              <div className="flex gap-2.5">
                <SafeImg
                  src={reverseImg}
                  alt="反推对象"
                  className="h-16 w-16 shrink-0 rounded-[8px] border border-theme object-cover"
                />
                <div className="min-w-0 flex-1">
                  {reverseBusy ? (
                    <div className="flex h-16 items-center gap-2 text-[12px] text-tertiary">
                      <span className="flex gap-1">
                        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
                        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
                        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
                      </span>
                      正在反推…
                    </div>
                  ) : reverseError ? (
                    <div className="text-[12px] leading-snug text-danger">
                      {adapterErrorTitle(reverseError)}
                      <div className="mt-0.5 break-all text-[11px] text-tertiary">
                        {reverseError.message}
                      </div>
                    </div>
                  ) : (
                    <textarea
                      value={reverseResult}
                      onChange={(e) => setReverseResult(e.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-[8px] border border-theme bg-transparent px-2.5 py-1.5 text-[12px] leading-relaxed outline-none focus:border-accent"
                    />
                  )}
                </div>
              </div>
            )}
            {reverseResult && !reverseBusy && (
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="pressable rounded-[8px] border border-theme px-3 py-1.5 text-[12px] text-secondary"
                >
                  换一张
                </button>
                <button
                  onClick={() => {
                    setDraftPrompt(reverseResult);
                    onClose();
                  }}
                  className="pressable rounded-[8px] bg-accent px-3 py-1.5 text-[12px] text-white"
                >
                  填入输入框
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
