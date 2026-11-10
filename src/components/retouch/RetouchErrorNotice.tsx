import { useTranslation } from "react-i18next";
import {
  adapterErrorTitle,
  isUnconfirmedError,
  type AdapterError,
} from "../../lib/api";
import { toast } from "../../lib/notify";
import { Button } from "../ui/Button";

interface Props {
  error: AdapterError;
  recovering: boolean;
  onRecover: () => void;
  onDismiss: () => void;
}

/// 修图台的错误条：未确认时把「可能已计费 + 请求 ID + 尝试恢复」一次说清。
/// 收起只是清状态，不重试；重试要经过 RetouchView 的确认弹窗。
export default function RetouchErrorNotice({
  error,
  recovering,
  onRecover,
  onDismiss,
}: Props) {
  const { t } = useTranslation();
  const unconfirmed = isUnconfirmedError(error);
  const requestId = error.type === "unconfirmed" ? error.request_id : undefined;

  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-card border border-danger/25 bg-danger/10 px-3 py-2 text-footnote text-danger"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words">
          {t("{{title}}：{{message}}", {
            title: adapterErrorTitle(error),
            message: error.message,
          })}
        </span>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t("关闭提示")}
        </Button>
      </div>

      {unconfirmed && (
        <span className="text-warning">{t("可能已计费，重试会再次扣费")}</span>
      )}

      {requestId && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(requestId)
                .then(() => toast(t("已复制请求 ID")))
                .catch(() => toast(t("复制失败"), "error"));
            }}
            className="break-all text-left transition-colors hover:text-primary"
            title={t("复制请求 ID（对账用）")}
          >
            {t("请求 ID：{{id}}", { id: requestId })}
          </button>
          <Button
            size="sm"
            variant="ghost"
            loading={recovering}
            onClick={onRecover}
          >
            {t("尝试恢复")}
          </Button>
        </div>
      )}
    </div>
  );
}
