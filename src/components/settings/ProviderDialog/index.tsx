import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  EMPTY_PROVIDER,
  ModelCaps,
  ProviderInput,
  ProviderItem,
  ProviderKeyView,
} from "../../../lib/api";
import { useProviderStore } from "../../../stores/providerStore";
import { useModelCapsStore } from "../../../lib/useModelCaps";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { cn } from "../../ui/cn";
import { BasicFields } from "./BasicFields";
import { ModelSection } from "./ModelSection";
import { resolveCaps } from "./caps";

const STEPS = ["基本信息", "拉取模型", "完成"] as const;

export default function ProviderDialog({
  initial,
  onClose,
}: {
  initial: ProviderItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
    resolveCaps(model, capsEdits, storedCaps);

  const patchCaps = (model: string, p: Partial<ModelCaps>) =>
    setCapsEdits((prev) => ({
      ...prev,
      [model]: { ...capsOf(model), ...p },
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
          setError(
            t("服务商已保存，但模型能力保存失败：{{error}}", {
              error: String(e),
            }),
          );
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
        ? t("下一步")
        : t("拉取模型列表")
      : t("下一步");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={providerId ? t("编辑服务商") : t("新增服务商")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <Button onClick={() => setStep(step - 1)}>{t("上一步")}</Button>
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
                {t("保存")}
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-2" aria-label={t("配置步骤")}>
        {STEPS.map((label, i) => (
          <span
            key={label}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "rounded-pill px-2.5 py-1 text-footnote",
              i === step
                ? "bg-accent-soft font-medium text-accent-text"
                : "bg-fill text-tertiary",
            )}
          >
            {i + 1} {t(label)}
          </span>
        ))}
      </div>

      {step === 0 && (
        <BasicFields
          form={form}
          patch={patch}
          initial={initial}
          providerId={providerId}
          keys={keys}
          newKey={newKey}
          onNewKeyChange={setNewKey}
          keyError={keyError}
          onAddKey={doAddKey}
          onDeleteKey={doDeleteKey}
          onResetKey={doResetKey}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
        />
      )}

      {step > 0 && (
        <ModelSection
          step={step}
          form={form}
          patch={patch}
          models={models}
          setModels={setModels}
          capsOf={capsOf}
          patchCaps={patchCaps}
        />
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
