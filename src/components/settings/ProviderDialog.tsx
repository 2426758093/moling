import { useEffect, useRef, useState } from "react";
import {
  api,
  EMPTY_PROVIDER,
  ProviderInput,
  ProviderItem,
} from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { inputCls, KIND_OPTIONS } from "./ui";

export default function ProviderDialog({
  initial,
  onClose,
}: {
  initial: ProviderItem | null;
  onClose: () => void;
}) {
  const save = useProviderStore((s) => s.save);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // 无障碍：Esc 关闭，打开时把焦点交给第一个可编辑控件
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current
      ?.querySelector<HTMLElement>("input,select,textarea")
      ?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (p: Partial<ProviderInput>) => setForm((f) => ({ ...f, ...p }));

  const doPullModels = async () => {
    setBusy(true);
    setError("");
    try {
      const list = await api.testModels(form);
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
      await save({ ...form, modelsJson: JSON.stringify(models) });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={initial?.provider.id ? "编辑服务商" : "新增服务商"}
        className="w-[480px] rounded-[var(--radius-pop)] bg-elevated p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold">
          {initial?.provider.id ? "编辑服务商" : "新增服务商"}
        </h3>

        <div className="mb-4 flex gap-1 text-xs">
          {["1 基本信息", "2 拉取模型", "3 完成"].map((t, i) => (
            <span
              key={t}
              className={`rounded-full px-2.5 py-1 ${
                i === step ? "bg-accent text-white" : "bg-hover text-tertiary"
              }`}
            >
              {t}
            </span>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs text-secondary">名称</div>
              <input
                className={inputCls}
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="例如：SiliconFlow"
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-secondary">接口类型</div>
              <select
                className={inputCls}
                value={form.kind}
                onChange={(e) => patch({ kind: e.target.value })}
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            {form.kind !== "mock" && (
              <>
                <div>
                  <div className="mb-1 text-xs text-secondary">
                    API 地址（Base URL）
                  </div>
                  <input
                    className={inputCls}
                    value={form.baseUrl}
                    onChange={(e) => patch({ baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-secondary">
                    API Key
                    {initial?.hasKey && (
                      <span className="ml-2 text-tertiary">
                        已保存 {initial.apiKeyMasked}（留空则不变）
                      </span>
                    )}
                  </div>
                  <input
                    className={inputCls}
                    type="password"
                    value={form.apiKey ?? ""}
                    onChange={(e) => patch({ apiKey: e.target.value })}
                    placeholder={
                      initial?.hasKey ? "留空则继续使用已保存的 Key" : "sk-..."
                    }
                  />
                  {initial?.hasKey && (
                    <div className="mt-1 text-[11px] text-tertiary">
                      出于安全考虑不回填明文 Key；留空保存即保持不变。
                    </div>
                  )}
                </div>
              </>
            )}
            {form.kind === "template" && (
              <>
                <div>
                  <div className="mb-1 text-xs text-secondary">
                    请求地址模板（可用 {"{{prompt}} {{image}} {{size}} {{key}}"}{" "}
                    等占位符）
                  </div>
                  <input
                    className={inputCls}
                    value={form.templateUrl}
                    onChange={(e) => patch({ templateUrl: e.target.value })}
                    placeholder="https://api.example.com/draw?prompt={{prompt}}"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-secondary">
                    请求体模板（JSON）
                  </div>
                  <textarea
                    className={`${inputCls} resize-none font-mono text-xs`}
                    rows={3}
                    value={form.templateBody}
                    onChange={(e) => patch({ templateBody: e.target.value })}
                    placeholder={'{"prompt":"{{prompt}}","size":"{{size}}"}'}
                  />
                  <div className="mt-1 text-[11px] leading-relaxed text-tertiary">
                    可用变量：prompt / negative_prompt / size / width / height /
                    model / seed / count / key / image / images / image_count。
                    image 为第一张参考图的 base64；模板接口暂不支持局部重绘、 AI
                    消除与扩图。
                  </div>
                </div>
              </>
            )}
            <div>
              <div className="mb-1 text-xs text-secondary">超时（秒）</div>
              <input
                className={inputCls}
                type="number"
                value={form.timeoutSecs}
                onChange={(e) => patch({ timeoutSecs: Number(e.target.value) })}
              />
            </div>
            {form.kind === "openai" && (
              <div>
                <div className="mb-1 text-xs text-secondary">
                  透传参数（JSON，可选，合并进请求体）
                </div>
                <textarea
                  className={`${inputCls} resize-none font-mono text-xs`}
                  rows={2}
                  value={form.extraParams ?? ""}
                  onChange={(e) => patch({ extraParams: e.target.value })}
                  placeholder='{"quality":"high"} 或 {"steps":30,"seed":42}'
                />
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            {form.kind === "template" ? (
              <div>
                <div className="mb-1 text-xs text-secondary">
                  手动填写模型列表（英文逗号分隔）
                </div>
                <input
                  className={inputCls}
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
              </div>
            ) : (
              <p className="text-sm text-secondary">
                点击下一步自动请求服务商的模型列表接口。
              </p>
            )}
            {models.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <span
                    key={m}
                    className="rounded-full bg-hover px-2 py-0.5 text-xs text-secondary"
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
            <div>
              <div className="mb-1 text-xs text-secondary">默认模型</div>
              <select
                className={inputCls}
                value={form.defaultModel}
                onChange={(e) => patch({ defaultModel: e.target.value })}
              >
                <option value="">（未选择）</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-sm text-secondary">
              共获取 {models.length} 个模型，保存后可在生成页直接使用。
            </p>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-[10px] border border-danger/25 bg-danger/10 p-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-between">
          <button
            onClick={onClose}
            className="rounded-[10px] px-3 py-1.5 text-sm text-secondary hover:text-primary"
          >
            取消
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="rounded-[10px] border border-theme px-3 py-1.5 text-sm"
              >
                上一步
              </button>
            )}
            {step < 1 && (
              <button
                onClick={() => setStep(1)}
                className="rounded-[10px] bg-accent px-4 py-1.5 text-sm text-white"
              >
                下一步
              </button>
            )}
            {step === 1 &&
              (form.kind === "template" ? (
                <button
                  onClick={() => setStep(2)}
                  className="rounded-[10px] bg-accent px-4 py-1.5 text-sm text-white"
                >
                  下一步
                </button>
              ) : (
                <button
                  onClick={doPullModels}
                  disabled={busy}
                  className="rounded-[10px] bg-accent px-4 py-1.5 text-sm text-white transition-opacity disabled:opacity-50"
                >
                  {busy ? "拉取中…" : "拉取模型列表"}
                </button>
              ))}
            {step === 2 && (
              <button
                onClick={doSave}
                disabled={busy}
                className="rounded-[10px] bg-accent px-4 py-1.5 text-sm text-white transition-opacity disabled:opacity-50"
              >
                {busy ? "保存中…" : "保存"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
