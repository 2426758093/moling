import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelCaps, ProviderInput } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Select } from "../../ui/Select";
import { Skeleton } from "../../ui/Skeleton";
import { Switch } from "../../ui/Switch";
import { cn } from "../../ui/cn";
import { CAP_FIELDS } from "./caps";
import {
  ConnectionErrorBanner,
  type ConnectionErrorInfo,
} from "./connectionError";
import {
  filterAndSortModels,
  isImageModel,
  type ModelFilter,
  type ModelSort,
} from "./modelPull";

export function ModelSection({
  step,
  form,
  patch,
  models,
  setModels,
  capsOf,
  patchCaps,
  pulling,
  pullError,
  onReload,
  capsEditCount,
  recommendedModels = [],
}: {
  step: number;
  form: ProviderInput;
  patch: (p: Partial<ProviderInput>) => void;
  models: string[];
  setModels: (list: string[]) => void;
  capsOf: (model: string) => ModelCaps;
  patchCaps: (model: string, patch: Partial<ModelCaps>) => void;
  pulling: boolean;
  pullError: ConnectionErrorInfo | null;
  onReload: () => void;
  capsEditCount: number;
  recommendedModels?: readonly string[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [sort, setSort] = useState<ModelSort>("default");
  const [capsOpen, setCapsOpen] = useState(false);

  const recommendedSet = new Set(recommendedModels);
  const visibleModels = filterAndSortModels(models, {
    query,
    filter,
    sort,
    recommended: recommendedModels,
  });

  if (step === 2) {
    const missingModels = models.length === 0 && form.kind !== "template";
    return (
      <div className="space-y-3">
        <div className="text-subhead text-secondary">{t("保存前确认")}</div>
        <dl className="divide-y divide-separator rounded-card border border-line text-subhead">
          <SummaryRow label={t("服务商")} value={form.name || t("未命名")} />
          <SummaryRow
            label={t("地址")}
            value={form.kind === "mock" ? t("（无地址）") : form.baseUrl || "—"}
          />
          <SummaryRow
            label={t("模型数")}
            value={t("{{n}} 个", { n: models.length })}
          />
          <SummaryRow
            label={t("默认模型")}
            value={form.defaultModel || t("（未选择）")}
          />
          <SummaryRow
            label={t("能力修改")}
            value={t("{{n}} 项", { n: capsEditCount })}
          />
        </dl>
        {missingModels && (
          <div
            role="alert"
            className="rounded-card border border-warning/30 bg-warning/10 px-3 py-2 text-footnote text-warning"
          >
            {t("还没有可用模型，请返回上一步拉取或检查地址与 Key。")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {form.kind === "template" ? (
        <Input
          label={t("模型列表（英文逗号分隔）")}
          value={models.join(",")}
          onChange={(e) =>
            setModels(
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-subhead text-secondary">{t("模型列表")}</span>
            <span className="text-footnote text-tertiary">
              {t("共 {{n}} 个模型", { n: models.length })}
            </span>
          </div>
          <Button
            size="sm"
            loading={pulling}
            disabled={pulling}
            onClick={() => void onReload()}
          >
            {t("重新拉取")}
          </Button>
        </div>
      )}

      {form.kind !== "template" && pulling && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-8" count={3} />
        </div>
      )}

      {form.kind !== "template" && !pulling && pullError && (
        <ConnectionErrorBanner error={pullError} onRetry={onReload} />
      )}

      {form.kind !== "template" &&
        !pulling &&
        !pullError &&
        models.length === 0 && (
          <p className="text-body text-secondary">
            {t("还没有模型，请检查地址与 Key 后重试。")}
          </p>
        )}

      {models.length > 0 && (
        <>
          {form.kind !== "template" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("搜索模型")}
                  aria-label={t("搜索模型")}
                  compact
                  widthClass="w-40"
                />
                <SegmentedControl
                  value={filter}
                  onValueChange={setFilter}
                  size="sm"
                  label={t("模型筛选")}
                  options={[
                    { value: "all", label: t("全部") },
                    { value: "image", label: t("图像") },
                    { value: "recommended", label: t("推荐") },
                  ]}
                />
                <Select
                  value={sort}
                  onValueChange={(v) => setSort(v as ModelSort)}
                  options={[
                    { value: "default", label: t("默认排序") },
                    { value: "name", label: t("名称 A–Z") },
                    { value: "recommended", label: t("推荐优先") },
                  ]}
                  label={t("排序")}
                  widthClass="w-32"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-subhead text-secondary">
                  {t("默认模型")}
                </span>
                <Select
                  value={form.defaultModel || "none"}
                  onValueChange={(v) =>
                    patch({ defaultModel: v === "none" ? "" : v })
                  }
                  options={[
                    { value: "none", label: t("（未选择）") },
                    ...models.map((m) => ({ value: m, label: m })),
                  ]}
                  label={t("默认模型")}
                />
              </div>

              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {visibleModels.map((model) => {
                  const active = form.defaultModel === model;
                  return (
                    <button
                      key={model}
                      type="button"
                      aria-pressed={active}
                      aria-label={t("把 {{model}} 设为默认模型", { model })}
                      onClick={() => patch({ defaultModel: model })}
                      className={cn(
                        "pressable flex w-full items-center gap-2 rounded-chip px-2 py-1 text-left font-mono text-footnote transition-colors",
                        active
                          ? "bg-accent-soft text-accent-text"
                          : "text-secondary hover:bg-hover hover:text-primary",
                      )}
                    >
                      <span className="min-w-0 flex-1 break-all">{model}</span>
                      {recommendedSet.has(model) && (
                        <span className="rounded-chip bg-fill px-1.5 py-0.5 text-caption text-tertiary">
                          {t("推荐")}
                        </span>
                      )}
                      {isImageModel(model) && !recommendedSet.has(model) && (
                        <span className="rounded-chip bg-fill px-1.5 py-0.5 text-caption text-tertiary">
                          {t("图像")}
                        </span>
                      )}
                      {active && (
                        <span className="rounded-chip bg-accent-soft px-1.5 py-0.5 text-caption text-accent-text">
                          {t("默认")}
                        </span>
                      )}
                    </button>
                  );
                })}
                {visibleModels.length === 0 && (
                  <p className="px-1 py-2 text-footnote text-tertiary">
                    {t("没有匹配的模型")}
                  </p>
                )}
              </div>
            </>
          )}

          <div className="rounded-card border border-line">
            <button
              type="button"
              aria-expanded={capsOpen}
              onClick={() => setCapsOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-card px-3 py-2 text-subhead text-secondary hover:bg-hover"
            >
              <span>
                {t("模型能力")}
                {capsEditCount > 0 && (
                  <span className="ml-1 text-footnote text-tertiary">
                    {t("{{n}} 项修改", { n: capsEditCount })}
                  </span>
                )}
              </span>
              <span aria-hidden className="text-tertiary">
                {capsOpen ? "▾" : "▸"}
              </span>
            </button>
            {capsOpen && (
              <div className="max-h-72 space-y-2 overflow-y-auto border-t border-line p-2.5">
                <p className="text-footnote text-tertiary">
                  {t("只影响界面可用项，不改变请求格式")}
                </p>
                {models.map((model) => {
                  const caps = capsOf(model);
                  return (
                    <div
                      key={model}
                      className="rounded-card border border-line p-2.5"
                    >
                      <div className="mb-2 break-all font-mono text-footnote text-secondary">
                        {model}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {CAP_FIELDS.map(({ key, label }) => (
                          <label
                            key={key}
                            className="flex items-center justify-between gap-2 text-footnote text-tertiary"
                          >
                            {t(label)}
                            <Switch
                              checked={caps[key]}
                              onCheckedChange={(v) =>
                                patchCaps(model, {
                                  [key]: v,
                                } as Partial<ModelCaps>)
                              }
                              label={`${model} ${t(label)}`}
                            />
                          </label>
                        ))}
                      </div>
                      <label className="mt-2 flex items-center justify-between gap-2 text-footnote text-tertiary">
                        {t("最大边长")}
                        <Input
                          type="number"
                          min={256}
                          max={8192}
                          step={64}
                          value={caps.maxSide}
                          onChange={(e) =>
                            patchCaps(model, {
                              maxSide: Number(e.target.value) || caps.maxSide,
                            })
                          }
                          onBlur={() =>
                            patchCaps(model, {
                              maxSide: Math.min(
                                8192,
                                Math.max(256, caps.maxSide),
                              ),
                            })
                          }
                          aria-label={t("{{model}} 最大边长", {
                            model,
                          })}
                          compact
                          widthClass="w-24"
                        />
                      </label>
                      {caps.gif && (
                        <label className="mt-2 flex items-center justify-between gap-2 text-footnote text-tertiary">
                          {t("GIF 帧数上限")}
                          <Input
                            type="number"
                            min={2}
                            max={64}
                            step={1}
                            value={caps.gifMaxFrames}
                            onChange={(e) =>
                              patchCaps(model, {
                                gifMaxFrames:
                                  Number(e.target.value) || caps.gifMaxFrames,
                              })
                            }
                            onBlur={() =>
                              patchCaps(model, {
                                gifMaxFrames: Math.min(
                                  64,
                                  Math.max(2, caps.gifMaxFrames),
                                ),
                              })
                            }
                            aria-label={t("{{model}} GIF 帧数上限", {
                              model,
                            })}
                            compact
                            widthClass="w-24"
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {form.kind === "template" && models.length > 0 && (
        <p className="text-body text-secondary">
          {t("共获取 {{n}} 个模型，保存后可在生成页直接使用。", {
            n: models.length,
          })}
        </p>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <dt className="shrink-0 text-secondary">{label}</dt>
      <dd className="min-w-0 break-all text-right text-primary">{value}</dd>
    </div>
  );
}
