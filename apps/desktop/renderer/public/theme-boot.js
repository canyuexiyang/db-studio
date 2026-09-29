/**
 * 主题启动引导（P1-2 无闪烁的关键）。
 *
 * 必须在【任何 CSS 应用之前】同步执行：读 localStorage 的主题偏好，
 * 解析出 dark|light 写到 <html data-theme>。晚于首帧再做这一步，
 * 深色用户每次启动都会看到一次白底闪烁。
 *
 * ⚠️ 三条约束（改前想清楚）：
 *  1. 不能用模块/打包 —— <head> 里的普通 <script src> 才是同步阻塞执行的
 *     （生产 CSP 是 script-src 'self'，外部文件正好合规；内联脚本会被拦）。
 *  2. 偏好值与 App.tsx 的 THEME_KEY 保持同键同义（dbstudio.theme）。
 *  3. localStorage 不可用（隐私模式等）时静默退回系统偏好，不抛错。
 */
(function () {
  var mode = 'system';
  try {
    var v = localStorage.getItem('dbstudio.theme');
    if (v === 'light' || v === 'dark') mode = v;
  } catch (e) {
    /* 读不到就用系统偏好 */
  }
  var dark;
  if (mode === 'dark') dark = true;
  else if (mode === 'light') dark = false;
  else {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      dark = false;
    }
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
