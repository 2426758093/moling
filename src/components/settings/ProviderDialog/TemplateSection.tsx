import { useTranslation } from "react-i18next";
import { ProviderInput } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { Input, Textarea } from "../../ui/Field";
import { DropdownMenu } from "../../ui/Menu";
import { IconChevron, IconPlus } from "../../Icons";

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
  const { t } = useTranslation();
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
          <Button size="sm">{t("插入占位符")}</Button>
        </DropdownMenu>
      </div>
      <Input
        label={t("请求地址")}
        value={url}
        onChange={(e) => onUrlChange(e.target.value)}
        placeholder="https://api.example.com/inpaint"
      />
      <Textarea
        label={t("请求体（JSON）")}
        rows={3}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder={'{"prompt":"{{prompt}}","image":"{{image}}"}'}
        className="font-mono text-subhead"
      />
      <Input
        label={t("响应路径")}
        value={responsePath}
        onChange={(e) => onResponsePathChange(e.target.value)}
        placeholder="data[0].b64_json"
        hint={t("留空按 data[0].b64_json 提取")}
      />
    </div>
  );
}

export function TemplateSection({
  form,
  patch,
  advancedOpen,
  onToggleAdvanced,
}: {
  form: ProviderInput;
  patch: (p: Partial<ProviderInput>) => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        label={t("请求地址模板")}
        value={form.templateUrl}
        onChange={(e) => patch({ templateUrl: e.target.value })}
        placeholder="https://api.example.com/draw?prompt={{prompt}}"
        hint={t("可用占位符：{{prompt}} {{image}} {{size}} {{key}}", {
          interpolation: { skipOnVariables: true },
          prompt: "{{prompt}}",
          image: "{{image}}",
          size: "{{size}}",
          key: "{{key}}",
        })}
      />
      <Textarea
        label={t("请求体模板（JSON）")}
        rows={3}
        value={form.templateBody}
        onChange={(e) => patch({ templateBody: e.target.value })}
        placeholder={'{"prompt":"{{prompt}}","size":"{{size}}"}'}
        className="font-mono text-subhead"
        hint={t(
          "可用变量：prompt / negative_prompt / size / width / height / model / seed / count / key / image / images / image_count。image 为第一张参考图的 base64。",
        )}
      />
      <div className="rounded-card border border-line">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => onToggleAdvanced()}
          className="flex w-full items-center justify-between rounded-card px-3 py-2 text-subhead text-secondary hover:bg-hover"
        >
          <span>
            {t("高级设置（编辑模板 / 变换模板）")}
            <span className="ml-1 text-footnote text-tertiary">
              {t("配置后可局部重绘、消除、扩图、放大与风格转换")}
            </span>
          </span>
          <IconChevron direction={advancedOpen ? "down" : "right"} size={14} />
        </button>
        {advancedOpen && (
          <div className="space-y-3 border-t border-line p-3">
            <TemplateSpecEditor
              title={t("编辑模板")}
              description={t("局部重绘 / AI 消除 / 扩图共用")}
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
              title={t("变换模板")}
              description={t("高清放大 / 风格转换共用")}
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
  );
}
