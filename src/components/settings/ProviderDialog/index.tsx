import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  EMPTY_PROVIDER,
  ModelCaps,
  ProviderInput,
  ProviderItem,
  ProviderKeyView,
} from "../../../lib/api";
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../../../lib/providerPresets";
import { useProviderStore } from "../../../stores/providerStore";
import { useModelCapsStore } from "../../../lib/useModelCaps";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { cn } from "../../ui/cn";
import { BasicFields } from "./BasicFields";
import { ModelSection } from "./ModelSection";
import { keepDefaultModel, pruneCapsEdits, resolveCaps } from "./caps";
import {
  describeConnectionError,
  type ConnectionErrorInfo,
  type ConnectionTestOutcome,
} from "./connectionError";
import { pullSignature, readPullCache, writePullCache } from "./modelPull";

const STEPS = ["基本信息", "拉取模型", "确认保存"] as const;

function presetForProvider(provider: ProviderInput): string | null {
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const hit = PROVIDER_PRESETS.find(
    (preset) =>
      preset.baseUrl !== "" &&
      preset.kind === provider.kind &&
      preset.baseUrl.replace(/\/+$/, "").toLowerCase() === baseUrl,
  );
  return hit?.id ?? null;
}

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
  // 编辑已存服务商时，改地址/类型后旧 Key 不再可信；必须重新输入 Key 才能测试/拉取。
  const typedKey = (form.apiKey ?? "").trim();
  const configChanged =
    providerId != null &&
    (form.baseUrl.trim().replace(/\/+$/, "") !==
      (initial?.provider.baseUrl ?? "").trim().replace(/\/+$/, "") ||
      form.kind !== initial?.provider.kind);
  const needsFreshKey = configChanged && !typedKey;
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
  const [activePresetId, setActivePresetId] = useState<string | null>(() =>
    initial ? presetForProvider(initial.provider) : null,
  );
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<ConnectionTestOutcome | null>(
    null,
  );
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<ConnectionErrorInfo | null>(null);
  // 丢弃过期响应：重新拉取 / 切换地址后，旧请求不得覆盖新结果
  const pullSeqRef = useRef(0);
  // 首次拉取才自动补默认模型；之后空值视为用户主动选择「未选择」
  const firstPullRef = useRef(models.length === 0);
  const lastAutoPullRef = useRef<string | null>(null);
  const testingRef = useRef(false);

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

  const patch = (p: Partial<ProviderInput>) => {
    // 地址 / 类型 / Key 改动后，先前的连接测试结论不再可信
    if ("baseUrl" in p || "kind" in p || "apiKey" in p) setTestOutcome(null);
    setForm((f) => ({ ...f, ...p }));
  };

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

  /** 拉取结果落地：保留仍存在的默认模型与能力修改，首次拉取补推荐默认值 */
  const applyModels = useCallback((list: string[]) => {
    const firstPull = firstPullRef.current;
    firstPullRef.current = false;
    setModels(list);
    setCapsEdits((prev) => pruneCapsEdits(prev, list));
    setForm((f) => ({
      ...f,
      // 用函数式更新读取最新的用户选择，拉取期间改过的默认模型不会被旧响应覆盖
      defaultModel: keepDefaultModel(
        list,
        f.defaultModel,
        firstPull || f.defaultModel !== "",
      ),
      modelsJson: JSON.stringify(list),
    }));
  }, []);

  const doPullModels = useCallback(
    async (force: boolean) => {
      if (form.kind === "template") return;
      if (needsFreshKey) {
        setPullError({
          title: "连接失败",
          detail: t("修改地址或接口类型后，请重新填写 API Key 再测试或拉取"),
          raw: "",
        });
        return;
      }
      const typed = typedKey;
      const signature = pullSignature(
        form,
        providerId,
        initial?.hasKey ?? false,
      );
      if (!force) {
        const cached = readPullCache(signature);
        if (cached) {
          applyModels(cached);
          return;
        }
      }
      const seq = ++pullSeqRef.current;
      setPulling(true);
      setPullError(null);
      try {
        // 编辑已有服务商且没输入新 Key 时走已存 Key（可能已在 Key 池里轮换），
        // 避免用空 Key 请求导致必然的鉴权失败
        const list =
          providerId != null && !typed
            ? await api.pullModels(providerId)
            : await api.testModels(form);
        if (seq !== pullSeqRef.current) return;
        writePullCache(signature, list);
        applyModels(list);
      } catch (e) {
        if (seq !== pullSeqRef.current) return;
        setPullError(describeConnectionError(String(e)));
      } finally {
        if (seq === pullSeqRef.current) setPulling(false);
      }
    },
    [
      applyModels,
      form,
      initial?.hasKey,
      needsFreshKey,
      providerId,
      t,
      typedKey,
    ],
  );

  // 进入模型步骤即自动拉取一次；同一签名只触发一次，「重新拉取」才强制刷新
  useEffect(() => {
    if (step !== 1 || form.kind === "template" || needsFreshKey) return;
    const signature = pullSignature(form, providerId, initial?.hasKey ?? false);
    if (lastAutoPullRef.current === signature) return;
    lastAutoPullRef.current = signature;
    void doPullModels(false);
  }, [step, form, providerId, initial?.hasKey, needsFreshKey, doPullModels]);

  const doTestConnection = async () => {
    if (testingRef.current) return;
    if (needsFreshKey) {
      setTestOutcome({
        ok: false,
        error: {
          title: "连接失败",
          detail: t("修改地址或接口类型后，请重新填写 API Key 再测试或拉取"),
          raw: "",
        },
      });
      return;
    }
    testingRef.current = true;
    setTesting(true);
    setTestOutcome(null);
    const typed = typedKey;
    try {
      if (providerId != null && !typed) {
        const result = await api.testConnection(providerId);
        if (result.ok) {
          setTestOutcome({
            ok: true,
            latencyMs: result.latencyMs,
            modelCount: result.modelCount,
          });
        } else {
          setTestOutcome({
            ok: false,
            error: describeConnectionError(result.error, result.status),
          });
        }
      } else {
        // 新增服务商尚未入库，只能通过 test_models 验证；本地计时补上延迟展示
        const started = performance.now();
        const list = await api.testModels(form);
        setTestOutcome({
          ok: true,
          latencyMs: Math.round(performance.now() - started),
          modelCount: list.length,
        });
      }
    } catch (e) {
      setTestOutcome({ ok: false, error: describeConnectionError(String(e)) });
    } finally {
      testingRef.current = false;
      setTesting(false);
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    setActivePresetId(preset.id);
    setModels([]);
    setCapsEdits({});
    setPullError(null);
    setTestOutcome(null);
    firstPullRef.current = true;
    lastAutoPullRef.current = null;
    setForm((f) => ({
      ...f,
      name: preset.nameKey ? t(preset.nameKey) : preset.name,
      baseUrl: preset.baseUrl,
      kind: preset.kind,
      modelsJson: "",
    }));
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

  const recommendedModels =
    PROVIDER_PRESETS.find((preset) => preset.id === activePresetId)
      ?.recommendedModels ?? [];
  const canSave = models.length > 0 || form.kind === "template";
  const canTest =
    form.kind !== "template" &&
    (form.kind === "mock" || form.baseUrl.trim() !== "");

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
            {step < 2 && (
              <Button variant="primary" onClick={() => setStep(step + 1)}>
                {t("下一步")}
              </Button>
            )}
            {step === 2 && (
              <Button
                variant="primary"
                loading={busy}
                disabled={!canSave}
                onClick={doSave}
              >
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
          activePresetId={activePresetId}
          onApplyPreset={applyPreset}
          testing={testing}
          testResult={testOutcome}
          onTestConnection={doTestConnection}
          canTest={canTest}
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
          pulling={pulling}
          pullError={pullError}
          onReload={() => void doPullModels(true)}
          capsEditCount={Object.keys(capsEdits).length}
          recommendedModels={recommendedModels}
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
