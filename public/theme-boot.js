/* 首帧主题镜像：在 React 挂载前把 localStorage 里的外观恢复到 <html>，
   消除"先白后深"的闪屏。真正的权威值在 SQLite，main.tsx 读取后会再次覆盖。
   键名必须与 src/lib/theme.ts 的 MIRROR_KEYS 一致。
   data-glass 现在表示纸面质感（clear 素纸 / standard 宣纸 / tinted 熟宣），
   属性名沿用旧版以保证旧偏好无需迁移。 */
(function () {
  var el = document.documentElement;
  var read = function (key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  var theme = read("moling.theme");
  var glass = read("moling.glass");
  var transparency = read("moling.transparency");

  var dark =
    theme === "dark" ||
    (theme !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  el.classList.toggle("dark", dark);

  if (glass === "clear" || glass === "standard" || glass === "tinted") {
    el.dataset.glass = glass;
  }
  el.dataset.transparency = transparency === "reduced" ? "reduced" : "full";
})();
