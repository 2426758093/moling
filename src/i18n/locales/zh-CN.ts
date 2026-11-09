/// 源语言资源：key 即中文原文，因此 value 与 key 相同，无需重复维护。
///
/// i18next 在 zh-CN 下找不到词条时会直接回显 key（即中文原文），
/// 所以这里保持空对象；新增文案只需要在 en-US 侧补翻译。
const zhCN = {} as const;

export default zhCN;
