import { useTranslation } from "react-i18next";
import { type AdapterError, parseAdapterError } from "../../../lib/api";
import { toast } from "../../../lib/notify";
import { Button } from "../../ui/Button";

export type ConnectionErrorTitle =
  | "连接失败"
  | "Key 无效，请检查 API Key"
  | "Key 无权限访问该接口"
  | "Base URL 可能缺少 /v1"
  | "服务商响应超时"
  | "网络错误，请检查地址或代理"
  | "余额不足或触发限额"
  | "该服务商不支持此操作";

export interface ConnectionErrorInfo {
  /** 结论文案（i18n key） */
  title: ConnectionErrorTitle;
  /** 服务商原始消息（已截断，供界面展示） */
  detail: string;
  /** 完整原始消息（供复制） */
  raw: string;
}

/** 内联「测试连接」的结果；错误已映射成可读结论 */
export interface ConnectionTestOutcome {
  ok: boolean;
  latencyMs?: number;
  modelCount?: number;
  error?: ConnectionErrorInfo;
}

const MAX_DETAIL_LENGTH = 240;

// eslint-disable-next-line react-refresh/only-export-components -- 错误映射与横幅同文件，测试与调用方直接复用
export function truncateDetail(raw: string, max = MAX_DETAIL_LENGTH): string {
  const text = raw.trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把连接错误映射成人能看懂的结论：
 * 401 → Key 无效；404 → Base URL 可能缺少 /v1；超时 → 响应超时；
 * 网络 → 检查地址/代理；其余保留原始消息（截断展示）。
 */
// eslint-disable-next-line react-refresh/only-export-components -- 错误映射与横幅同文件，测试与调用方直接复用
export function describeConnectionError(
  error: AdapterError | string | undefined,
  status?: number,
): ConnectionErrorInfo {
  const adapter = typeof error === "string" ? parseAdapterError(error) : error;
  const raw = typeof error === "string" ? error : (error?.message ?? "");
  const message = adapter?.message?.trim() || raw.trim();
  const text = message.toLowerCase();
  const code =
    status ??
    (adapter && "status" in adapter && typeof adapter.status === "number"
      ? adapter.status
      : undefined);

  let title: ConnectionErrorTitle = "连接失败";
  if (
    code === 401 ||
    adapter?.type === "auth_invalid" ||
    /(^|\D)401(\D|$)|unauthorized|invalid[_ -]?key|incorrect api key/.test(text)
  ) {
    title = "Key 无效，请检查 API Key";
  } else if (code === 403) {
    title = "Key 无权限访问该接口";
  } else if (code === 404 || /(^|\D)404(\D|$)|not found|no route/.test(text)) {
    title = "Base URL 可能缺少 /v1";
  } else if (
    adapter?.type === "timeout" ||
    /timeout|timed out|超时/.test(text)
  ) {
    title = "服务商响应超时";
  } else if (
    adapter?.type === "network" ||
    /network|failed to fetch|dns|econn|socket|proxy|connection refused/.test(
      text,
    )
  ) {
    title = "网络错误，请检查地址或代理";
  } else if (adapter?.type === "quota_exceeded" || code === 429) {
    title = "余额不足或触发限额";
  } else if (adapter?.type === "unsupported") {
    title = "该服务商不支持此操作";
  }

  return {
    title,
    detail: truncateDetail(message),
    raw: message,
  };
}

/** 连接 / 拉取失败横幅：结论 + 截断的原始消息 + 复制 + 可选重试 */
export function ConnectionErrorBanner({
  error,
  onRetry,
}: {
  error: ConnectionErrorInfo;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();

  const copy = () => {
    if (!navigator.clipboard) {
      toast(t("复制失败"), "error");
      return;
    }
    void navigator.clipboard
      .writeText(error.raw)
      .then(() => toast(t("错误详情已复制")))
      .catch(() => toast(t("复制失败"), "error"));
  };

  return (
    <div
      role="alert"
      className="rounded-card border border-danger/25 bg-danger/10 px-3 py-2 text-footnote"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-danger">{t(error.title)}</div>
          {error.detail && (
            <div className="mt-0.5 break-all text-danger/80">
              {error.detail}
            </div>
          )}
        </div>
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t("重试")}
          </Button>
        )}
        {error.raw && (
          <Button size="sm" variant="ghost" onClick={copy}>
            {t("复制")}
          </Button>
        )}
      </div>
    </div>
  );
}
