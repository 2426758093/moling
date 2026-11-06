import { useCallback, useEffect, useState } from "react";
import {
  api,
  EMPTY_PROVIDER,
  ModelCaps,
  ProviderInput,
  ProviderItem,
  ProviderKeyView,
} from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { heuristicCaps, useModelCapsStore } from "../../lib/useModelCaps";
import { KIND_OPTIONS } from "./ui";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Textarea } from "../ui/Field";
import { DropdownMenu } from "../ui/Menu";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { cn } from "../ui/cn";
import { IconChevron, IconPlus } from "../Icons";

const STEPS = ["基本信息", "拉取模型", "完成"];

const CAP_FIELDS: {
  key: "negative" | "edit" | "transform" | "multiImage";
  label: string;
}[] = [
  { key: "negative", label: "负向提示词" },
  { key: "edit", label: "编辑能力" },
  { key: "transform", label: "变换能力" },
  { key: "multiImage", label: "多参考图" },
];

type SpecPrefix = "editTemplate" | "transformTemplate";

const SPEC_PLACEHOLDERS: Record<SpecPrefix, string[]> = {
  editTemplate: [
    "{{prompt}}",
    "{{negative_prompt}}",
    "{{image}}",
    "{{mask}}",
    "{{mask_count}}",
    "{{size}}",
    "{{model}}",
    "{{key}}",
  ],
  transformTemplate: [
    "{{prompt}}",
    "{{image}}",
    "{{scale}}",
    "{{mode}}",
    "{{model}}",
    "{{key}}",
  ],
};

/** 编辑 / 变换模板编辑块：URL + 请求体 + 响应路径，占位符可从菜单追加到请求体 */
function TemplateSpecEditor({
  title,
  description,
  placeholders,
  url,
  body,
  responsePath,
  onUrlChange,
  onBodyChange,
  onResponsePathChange,
}: {
  title: string;
  description: string;
  placeholders: string[];
  url: string;
  body: string;
  responsePath: string;
  onUrlChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onResponsePathChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-card border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-subhead text-primary">{title}</div>
          <div className="text-footnote text-tertiary">{description}</div>
        </div>
        <DropdownMenu
          align="end"
          items={placeholders.map((placeholder) => ({
            id: placeholder,
            label: placeholder,
            icon: <IconPlus size={14} />,
            onSelect: () => {
              const sep = body === "" || body.endsWith(" ") ? "" : " ";
              onBodyChange(`${body}${sep}${placeholder}`);
            },
          }))}
        >
          <Button size="sm">插入占位符</Button>
        </DropdownMenu>
      </div>
      <Input
        label="请求地址"
        value={url}
        onChange={(e) => onUrlChange(e.target.value)}
        placeholder="https://api.example.com/inpaint"
      />
      <Textarea
        label="请求体（JSON）"
        rows={3}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder={'{"prompt":"{{prompt}}","image":"{{image}}"}'}
        className="font-mono text-subhead"
      />
      <Input
        label="响应路径"
        value={responsePath}
        onChange={(e) => onResponsePathChange(e.target.value)}
        placeholder="data[0].b64_json"
        hint="留空按 data[0].b64_json 提取"
      />
    </div>
  );
}

export default function ProviderDialog({
  initial,
  onClose,
}: {
  initial: ProviderItem | null;
  onClose: () => void;
}) {
  const save = useProviderStore((s) => s.save);
  const refresh = useProviderStore((s) => s.refresh);
  const providerId = initial?.provider.id ?? null;
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<ProviderInput>(
    initial?.provider ?? EMPTY_PROVIDER,
  );
  const [models, setModels] = useState<string[]>(() => {
    try {
      return initial?.provider.modelsJson
        ? JSON.parse(initial.provider.modelsJson)
        : [];
    } catch {
      return [];
    }
  });
  const [keys, setKeys] = useState<ProviderKeyView[]>(initial?.keys ?? []);
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 已保存的能力表 + 本次编辑的覆盖项；未被用户改过的模型不落库，
  // 以便后端启发式规则后续升级时自动生效
  const [storedCaps, setStoredCaps] = useState<Record<string, ModelCaps>>({});
  const [capsEdits, setCapsEdits] = useState<Record<string, ModelCaps>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (providerId == null) return;
    let alive = true;
    void api
      .getModelCaps(providerId)
      .then((caps) => {
        if (alive) setStoredCaps(caps);
      })
      .catch(() => {
        // 读取失败按启发式展示，不阻断编辑
      });
    return () => {
      alive = false;
    };
  }, [providerId]);

  const capsOf = (model: string): ModelCaps =>
    capsEdits[model] ?? storedCaps[model] ?? heuristicCaps(model);

  const patchCaps = (model: string, patch: Partial<ModelCaps>) =>
    setCapsEdits((prev) => ({
      ...prev,
      [model]: { ...capsOf(model), ...patch },
    }));

  const patch = (p: Partial<ProviderInput>) => setForm((f) => ({ ...f, ...p }));

  const syncKeys = useCallback(
    (list: ProviderKeyView[]) => {
      setKeys(list);
      // 卡片上的「N 个 Key · M 失效」依赖服务商列表，改动后一并刷新
      void refresh();
    },
    [refresh],
  );

  const doAddKey = async () => {
    if (!providerId || !newKey.trim()) return;
    setKeyError("");
    try {
      const r = await api.addProviderKey(providerId, newKey.trim());
      setNewKey("");
      syncKeys(r.keys);
    } catch (e) {
      setKeyError(String(e));
    }
  };

  const doDeleteKey = async (index: number) => {
    if (!providerId) return;
    setKeyError("");
    try {
      const r = await api.deleteProviderKey(providerId, index);
      syncKeys(r.keys);
    } catch (e) {
      setKeyError(String(e));
    }
  };

  const doResetKey = async (index: number) => {
    if (!providerId) return;
    setKeyError("");
    try {
      const r = await api.resetProviderKey(providerId, index);
      syncKeys(r.keys);
    } catch (e) {
      setKeyError(String(e));
    }
  };

  const doPullModels = async () => {
    setBusy(true);
    setError("");
    try {
      // 编辑已有服务商且没输入新 Key 时走已存 Key（可能已在 Key 池里轮换），
      // 避免用空 Key 请求导致必然的鉴权失败
      const typed = (form.apiKey ?? "").trim();
      const list =
        providerId && !typed
          ? await api.pullModels(providerId)
          : await api.testModels(form);
      setModels(list);
      if (list.length > 0 && !form.defaultModel) {
        patch({ defaultModel: list[0] });
      }
      setForm((f) => ({ ...f, modelsJson: JSON.stringify(list) }));
      setStep(2);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await save({ ...form, modelsJson: JSON.stringify(models) });
      const savedId = saved.provider.id;
      const edited = Object.entries(capsEdits);
      if (savedId != null && edited.length > 0) {
        try {
          await api.saveModelCapsBatch(savedId, Object.fromEntries(edited));
          await useModelCapsStore.getState().load(savedId, true);
        } catch (e) {
          // 服务商本体已保存；能力批量写失败时不要静默关窗，让用户能重试
          setError(`服务商已保存，但模型能力保存失败：${String(e)}`);
          return;
        }
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const nextLabel =
    step === 1
      ? form.kind === "template"
        ? "下一步"
        : "拉取模型列表"
      : "下一步";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={providerId ? "编辑服务商" : "新增服务商"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <Button onClick={() => setStep(step - 1)}>上一步</Button>
            )}
            {step < 1 && (
              <Button variant="primary" onClick={() => setStep(1)}>
                {nextLabel}
              </Button>
            )}
            {step === 1 &&
              (form.kind === "template" ? (
                <Button variant="primary" onClick={() => setStep(2)}>
                  {nextLabel}
                </Button>
              ) : (
                <Button variant="primary" loading={busy} onClick={doPullModels}>
                  {nextLabel}
                </Button>
              ))}
            {step === 2 && (
              <Button variant="primary" loading={busy} onClick={doSave}>
                保存
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-2" aria-label="配置步骤">
        {STEPS.map((t, i) => (
          <span
            key={t}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "rounded-pill px-2.5 py-1 text-footnote",
              i === step
                ? "bg-accent-soft font-medium text-accent-text"
                : "bg-fill text-tertiary",
            )}
          >
            {i + 1} {t}
          </span>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <Input
            label="名称"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="例如：SiliconFlow"
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-subhead text-secondary">接口类型</span>
            <Select
              value={form.kind}
              onValueChange={(v) => patch({ kind: v })}
              options={KIND_OPTIONS.map((k) => ({
                value: k.id,
                label: k.label,
              }))}
              label="接口类型"
            />
          </div>
          {form.kind !== "mock" && (
            <>
              <Input
                label="API 地址（Base URL）"
                value={form.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
              <Input
                label="API Key"
                type="password"
                value={form.apiKey ?? ""}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder={
                  initial?.hasKey ? "留空则继续使用已保存的 Key" : "sk-..."
                }
                hint={
                  initial?.hasKey
                    ? `已保存 ${initial.apiKeyMasked}。出于安全考虑不回填明文 Key；留空保存即保持不变。${
                        keys.length > 1
                          ? " 填写新 Key 会替换第 1 个，其余保留。"
                          : ""
                      }`
                    : "仅保存在本机，不会随备份导出（除非显式勾选）"
                }
              />
              {providerId && (
                <div className="rounded-card border border-line p-3">
                  <div className="mb-2 flex items-center justify-between text-footnote">
                    <span className="text-secondary">
                      Key 池（鉴权失败时自动切换到下一个）
                    </span>
                    <span className="text-tertiary">
                      {keys.length} 个
                      {keys.some((k) => k.invalid) &&
                        ` · ${keys.filter((k) => k.invalid).length} 失效`}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {keys.map((k) => (
                      <div
                        key={k.index}
                        className="flex items-center gap-2 text-footnote"
                      >
                        <span className="font-mono text-secondary">
                          {k.index + 1}. {k.masked}
                        </span>
                        {k.invalid ? (
                          <span className="rounded-pill border border-danger/25 bg-danger/10 px-1.5 py-0.5 text-caption text-danger">
                            已失效
                          </span>
                        ) : (
                          <span className="text-caption text-tertiary">
                            可用
                          </span>
                        )}
                        <div className="ml-auto flex gap-1">
                          {k.invalid && (
                            <Button
                              size="sm"
                              onClick={() => void doResetKey(k.index)}
                              aria-label={`恢复 Key ${k.index + 1}`}
                            >
                              恢复
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => void doDeleteKey(k.index)}
                            aria-label={`删除 Key ${k.index + 1}`}
                          >
                            删除
                          </Button>
                        </div>
                      </div>
                    ))}
                    {keys.length === 0 && (
                      <div className="text-footnote text-tertiary">
                        还没有 Key，可在上方 API Key 里填写主 Key 后保存。
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Input
                        type="password"
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)}
                        placeholder="添加备用 Key"
                        aria-label="添加备用 Key"
                      />
                    </div>
                    <Button
                      size="md"
                      disabled={!newKey.trim()}
                      onClick={() => void doAddKey()}
                    >
                      添加
                    </Button>
                  </div>
                  {keyError && (
                    <div className="mt-1 text-footnote text-danger">
                      {keyError}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {form.kind === "template" && (
            <>
              <Input
                label="请求地址模板"
                value={form.templateUrl}
                onChange={(e) => patch({ templateUrl: e.target.value })}
                placeholder="https://api.example.com/draw?prompt={{prompt}}"
                hint="可用占位符：{{prompt}} {{image}} {{size}} {{key}}"
              />
              <Textarea
                label="请求体模板（JSON）"
                rows={3}
                value={form.templateBody}
                onChange={(e) => patch({ templateBody: e.target.value })}
                placeholder={'{"prompt":"{{prompt}}","size":"{{size}}"}'}
                className="font-mono text-subhead"
                hint="可用变量：prompt / negative_prompt / size / width / height / model / seed / count / key / image / images / image_count。image 为第一张参考图的 base64。"
              />
              <div className="rounded-card border border-line">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex w-full items-center justify-between rounded-card px-3 py-2 text-subhead text-secondary hover:bg-hover"
                >
                  <span>
                    高级设置（编辑模板 / 变换模板）
                    <span className="ml-1 text-footnote text-tertiary">
                      配置后可局部重绘、消除、扩图、放大与风格转换
                    </span>
                  </span>
                  <IconChevron
                    direction={advancedOpen ? "down" : "right"}
                    size={14}
                  />
                </button>
                {advancedOpen && (
                  <div className="space-y-3 border-t border-line p-3">
                    <TemplateSpecEditor
                      title="编辑模板"
                      description="局部重绘 / AI 消除 / 扩图共用"
                      placeholders={SPEC_PLACEHOLDERS.editTemplate}
                      url={form.editTemplateUrl}
                      body={form.editTemplateBody}
                      responsePath={form.editTemplateResponsePath}
                      onUrlChange={(v) => patch({ editTemplateUrl: v })}
                      onBodyChange={(v) => patch({ editTemplateBody: v })}
                      onResponsePathChange={(v) =>
                        patch({ editTemplateResponsePath: v })
                      }
                    />
                    <TemplateSpecEditor
                      title="变换模板"
                      description="高清放大 / 风格转换共用"
                      placeholders={SPEC_PLACEHOLDERS.transformTemplate}
                      url={form.transformTemplateUrl}
                      body={form.transformTemplateBody}
                      responsePath={form.transformTemplateResponsePath}
                      onUrlChange={(v) => patch({ transformTemplateUrl: v })}
                      onBodyChange={(v) => patch({ transformTemplateBody: v })}
                      onResponsePathChange={(v) =>
                        patch({ transformTemplateResponsePath: v })
                      }
                    />
                  </div>
                )}
              </div>
            </>
          )}
          <Input
            label="超时（秒）"
            type="number"
            min={5}
            max={1800}
            value={form.timeoutSecs}
            onChange={(e) => patch({ timeoutSecs: Number(e.target.value) })}
            hint="等待服务商返回响应的上限。图片生成（高画质 / 多参考图）常需 1–5 分钟，建议不低于 300 秒；客户端提前断开时上游可能仍在生成并计费"
          />
          {form.kind === "openai" && (
            <Textarea
              label="透传参数（JSON，可选）"
              rows={2}
              value={form.extraParams ?? ""}
              onChange={(e) => patch({ extraParams: e.target.value })}
              placeholder='{"quality":"high"} 或 {"steps":30,"seed":42}'
              className="font-mono text-subhead"
              hint="会合并进请求体，优先于默认参数"
            />
          )}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          {form.kind === "template" ? (
            <Input
              label="模型列表（英文逗号分隔）"
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
              点击「拉取模型列表」自动请求服务商的模型接口。
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
            <span className="text-subhead text-secondary">默认模型</span>
            <Select
              value={form.defaultModel || "none"}
              onValueChange={(v) =>
                patch({ defaultModel: v === "none" ? "" : v })
              }
              options={[
                { value: "none", label: "（未选择）" },
                ...models.map((m) => ({ value: m, label: m })),
              ]}
              label="默认模型"
            />
          </div>
          {models.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-subhead text-secondary">模型能力</span>
                <span className="text-footnote text-tertiary">
                  只影响界面可用项，不改变请求格式
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
                            {label}
                            <Switch
                              checked={caps[key]}
                              onCheckedChange={(v) =>
                                patchCaps(m, { [key]: v } as Partial<ModelCaps>)
                              }
                              label={`${m} ${label}`}
                            />
                          </label>
                        ))}
                      </div>
                      <label className="mt-2 flex items-center justify-between gap-2 text-footnote text-tertiary">
                        最大边长
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
                          aria-label={`${m} 最大边长`}
                          compact
                          widthClass="w-24"
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <p className="text-body text-secondary">
            共获取 {models.length} 个模型，保存后可在生成页直接使用。
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-card border border-danger/25 bg-danger/10 p-2 text-subhead text-danger"
        >
          {error}
        </div>
      )}
    </Dialog>
  );
}
