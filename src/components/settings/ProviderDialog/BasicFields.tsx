import { useTranslation } from "react-i18next";
import { ProviderInput, ProviderItem, ProviderKeyView } from "../../../lib/api";
import {
  keyOptionalFor,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../../../lib/providerPresets";
import { KIND_OPTIONS } from "../ui";
import { Button } from "../../ui/Button";
import { Input, Textarea } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { cn } from "../../ui/cn";
import {
  ConnectionErrorBanner,
  type ConnectionTestOutcome,
} from "./connectionError";
import { KeyManager } from "./KeyManager";
import { TemplateSection } from "./TemplateSection";

export function BasicFields({
  form,
  patch,
  initial,
  providerId,
  keys,
  newKey,
  onNewKeyChange,
  keyError,
  onAddKey,
  onDeleteKey,
  onResetKey,
  advancedOpen,
  onToggleAdvanced,
  activePresetId,
  onApplyPreset,
  testing,
  testResult,
  onTestConnection,
  canTest,
}: {
  form: ProviderInput;
  patch: (p: Partial<ProviderInput>) => void;
  initial: ProviderItem | null;
  providerId: number | null;
  keys: ProviderKeyView[];
  newKey: string;
  onNewKeyChange: (v: string) => void;
  keyError: string;
  onAddKey: () => void;
  onDeleteKey: (index: number) => void;
  onResetKey: (index: number) => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  activePresetId: string | null;
  onApplyPreset: (preset: ProviderPreset) => void;
  testing: boolean;
  testResult: ConnectionTestOutcome | null;
  onTestConnection: () => void;
  canTest: boolean;
}) {
  const { t } = useTranslation();
  const activePreset =
    PROVIDER_PRESETS.find((preset) => preset.id === activePresetId) ?? null;
  const keyOptional = keyOptionalFor(form.baseUrl, form.kind);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-subhead text-secondary">{t("快速预设")}</span>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_PRESETS.map((preset) => {
            const active = preset.id === activePresetId;
            const label = preset.nameKey ? t(preset.nameKey) : preset.name;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                onClick={() => onApplyPreset(preset)}
                className={cn(
                  "pressable rounded-chip border px-2 py-1 text-footnote transition-colors",
                  active
                    ? "border-accent bg-accent-soft font-medium text-accent-text"
                    : "border-line bg-fill text-secondary hover:bg-hover hover:text-primary",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        {activePreset && (
          <p className="text-footnote text-tertiary">
            {t(activePreset.hint)}
            {activePreset.recommendedModels.length > 0 &&
              ` ${t("推荐模型：{{models}}", {
                models: activePreset.recommendedModels.join(" / "),
              })}`}
          </p>
        )}
      </div>

      <Input
        label={t("名称")}
        value={form.name}
        onChange={(e) => patch({ name: e.target.value })}
        placeholder={t("例如：SiliconFlow")}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-subhead text-secondary">{t("接口类型")}</span>
        <Select
          value={form.kind}
          onValueChange={(v) => patch({ kind: v })}
          options={KIND_OPTIONS.map((k) => ({
            value: k.id,
            label: t(k.label),
          }))}
          label={t("接口类型")}
        />
      </div>
      {form.kind !== "mock" && (
        <>
          <Input
            label={t("API 地址（Base URL）")}
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
              initial?.hasKey
                ? t("留空则继续使用已保存的 Key")
                : keyOptional
                  ? t("本地服务可留空")
                  : "sk-..."
            }
            hint={
              initial?.hasKey
                ? keys.length > 1
                  ? t(
                      "已保存 {{key}}。出于安全考虑不回填明文 Key；留空保存即保持不变。填写新 Key 会替换第 1 个，其余保留。",
                      { key: initial.apiKeyMasked },
                    )
                  : t(
                      "已保存 {{key}}。出于安全考虑不回填明文 Key；留空保存即保持不变。",
                      { key: initial.apiKeyMasked },
                    )
                : keyOptional
                  ? t("本地服务可以不填 Key")
                  : t("仅保存在本机，不会随备份导出（除非显式勾选）")
            }
          />
          {providerId && (
            <KeyManager
              keys={keys}
              newKey={newKey}
              onNewKeyChange={onNewKeyChange}
              keyError={keyError}
              onAdd={onAddKey}
              onDelete={onDeleteKey}
              onReset={onResetKey}
            />
          )}
        </>
      )}
      {form.kind === "template" && (
        <TemplateSection
          form={form}
          patch={patch}
          advancedOpen={advancedOpen}
          onToggleAdvanced={onToggleAdvanced}
        />
      )}

      {form.kind !== "template" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={testing}
            disabled={!canTest}
            onClick={() => void onTestConnection()}
          >
            {testing ? t("测试中…") : t("测试连接")}
          </Button>
          {testResult?.ok && (
            <span role="status" className="text-footnote text-success">
              {t("连接正常 · {{ms}}ms · {{n}} 个模型", {
                ms: testResult.latencyMs ?? 0,
                n: testResult.modelCount ?? 0,
              })}
            </span>
          )}
        </div>
      )}
      {testResult && !testResult.ok && testResult.error && (
        <ConnectionErrorBanner error={testResult.error} />
      )}

      <Input
        label={t("超时（秒）")}
        type="number"
        min={5}
        max={1800}
        value={form.timeoutSecs}
        onChange={(e) => patch({ timeoutSecs: Number(e.target.value) })}
        hint={t(
          "等待服务商返回响应的上限。图片生成（高画质 / 多参考图）常需 1–5 分钟，建议不低于 300 秒；客户端提前断开时上游可能仍在生成并计费",
        )}
      />
      {form.kind === "openai" && (
        <Textarea
          label={t("透传参数（JSON，可选）")}
          rows={2}
          value={form.extraParams ?? ""}
          onChange={(e) => patch({ extraParams: e.target.value })}
          placeholder={t('{"quality":"high"} 或 {"steps":30,"seed":42}')}
          className="font-mono text-subhead"
          hint={t("会合并进请求体，优先于默认参数")}
        />
      )}
    </div>
  );
}
