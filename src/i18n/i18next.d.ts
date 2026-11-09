import "i18next";
import type enUS from "./locales/en-US";

/// 以英文词典的 key 约束全部 t() 调用：新增文案若漏补英文会直接编译失败。
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof enUS };
    returnNull: false;
  }
}
