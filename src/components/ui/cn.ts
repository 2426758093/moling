/// 极简类名拼接：项目只用 Tailwind 语义类，不需要 tailwind-merge 的冲突消解，
/// 但需要把 false / undefined 串过滤掉，避免出现 "undefined" 字面量。
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
