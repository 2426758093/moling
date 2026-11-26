import { useTranslation } from "react-i18next";
import { ModelCaps, ProviderInput } from "../../../lib/api";
import { Input } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { CAP_FIELDS } from "./caps";

export function ModelSection({
  step,
  form,
  patch,
  models,
  setModels,
  capsOf,
  patchCaps,
}: {
  step: number;
  form: ProviderInput;
  patch: (p: Partial<ProviderInput>) => void;
  models: string[];
  setModels: (list: string[]) => void;
  capsOf: (model: string) => ModelCaps;
  patchCaps: (model: string, patch: Partial<ModelCaps>) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {step === 1 && (
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
            <p className="text-body text-secondary">
              {t("点击「拉取模型列表」自动请求服务商的模型接口。")}
            </p>
          )}
          {models.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {models.map((m) => (
                <span
                  key={m}
                  className="rounded-chip bg-fill px-2 py-0.5 text-footnote text-secondary"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-subhead text-secondary">{t("默认模型")}</span>
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
          {models.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-subhead text-secondary">
                  {t("模型能力")}
                </span>
                <span className="text-footnote text-tertiary">
                  {t("只影响界面可用项，不改变请求格式")}
                </span>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {models.map((m) => {
                  const caps = capsOf(m);
                  return (
                    <div
                      key={m}
                      className="rounded-card border border-line p-2.5"
                    >
                      <div className="mb-2 break-all font-mono text-footnote text-secondary">
                        {m}
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
                                patchCaps(m, { [key]: v } as Partial<ModelCaps>)
                              }
                              label={`${m} ${t(label)}`}
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
                            patchCaps(m, {
                              maxSide: Number(e.target.value) || caps.maxSide,
                            })
                          }
                          onBlur={() =>
                            patchCaps(m, {
                              maxSide: Math.min(
                                8192,
                                Math.max(256, caps.maxSide),
                              ),
                            })
                          }
                          aria-label={t("{{model}} 最大边长", { model: m })}
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
                              patchCaps(m, {
                                gifMaxFrames:
                                  Number(e.target.value) || caps.gifMaxFrames,
                              })
                            }
                            onBlur={() =>
                              patchCaps(m, {
                                gifMaxFrames: Math.min(
                                  64,
                                  Math.max(2, caps.gifMaxFrames),
                                ),
                              })
                            }
                            aria-label={t("{{model}} GIF 帧数上限", {
                              model: m,
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
            </div>
          )}
          <p className="text-body text-secondary">
            {t("共获取 {{n}} 个模型，保存后可在生成页直接使用。", {
              n: models.length,
            })}
          </p>
        </div>
      )}
    </>
  );
}
