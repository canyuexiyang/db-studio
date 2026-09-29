// 渲染进程探针：用「双 rAF」确认浏览器已完成首帧绘制（layout + paint），
// 再把「首次 paint」事件回传主进程。主进程以自身 performance.now() 时钟打点。
//
// C1（朴素）模式下，渲染进程在首帧前【同步 require CodeMirror】——
// 真实产品里编辑器本就在渲染进程，这里模拟「不做懒加载、启动即载入编辑器包」。
// C2/C3 不传 eager，渲染进程保持最小。
(function () {
  const { ipcRenderer } = require('electron');
  const eager = new URLSearchParams(location.search).get('eager') === '1';
  function paint() {
    ipcRenderer.send('probe:first-paint');
  }
  function start() {
    requestAnimationFrame(function () {
      requestAnimationFrame(paint);
    });
  }
  if (eager) {
    try {
      const cm = require('codemirror');
      window.__cmLoaded = typeof cm === 'function';
    } catch (e) {
      window.__cmError = String((e && e.stack) || e);
    }
  }
  start();
})();
