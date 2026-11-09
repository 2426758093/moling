import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enUS from "./locales/en-US";
import zhCN from "./locales/zh-CN";

export type Locale = "zh-CN" | "en-US";

/// 与 public/theme-boot.js 无关联：语言只在本模块读，首帧前由 main.tsx 恢复。
const LOCALE_MIRROR_KEY = "moling.locale";

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en-US";
}

/// 读 localStorage 镜像：隐私模式下可能抛错，统一回退中文。
export function readLocaleMirror(): Locale {
  try {
    const value = localStorage.getItem(LOCALE_MIRROR_KEY);
    if (isLocale(value)) return value;
  } catch {
    // 无存储权限：保持默认
  }
  return "zh-CN";
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "en-US": { translation: enUS },
  },
  lng: readLocaleMirror(),
  fallbackLng: "zh-CN",
  // 中文原文即 key：关闭分隔符，避免文案里的英文句点/冒号被当成层级
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/// 切换语言：立即生效，并写回镜像供下次启动首帧使用。
export function applyLocale(locale: Locale) {
  void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_MIRROR_KEY, locale);
  } catch {
    // 写不进去不影响当前会话
  }
}

export default i18n;
