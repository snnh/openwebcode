/**
 * owc-dsh-bridge：随 owc 发布的 dsh client 插件（M4 步骤 18）。
 *
 * 形态：普通 dsh client 插件 bundle —— 顶层即 `window.__ModuleLoader__.load({id, factory})`，
 * factory 内导出 cordis 插件 `apply(ctx)`；随 owc 发布（`server/assets/dsh-bridge/client.js`），
 * 由翻译层自动追加进 boot graph（application phase）。
 *
 * 职责（v1）：
 *   1. 从同源 `/dsh-owc/status` 取 owc 事实（版本、权限模式、快照后端、Workbench 回跳 URL）；
 *   2. 注入 `globalThis.__OWC_DSH__`（供 dsh 侧脚本/其它插件读取，只读快照）；
 *   3. 右下角悬浮「返回 Workbench」入口（dsh UI 无该插槽时的兜底；不覆盖 dsh 自身 UI）。
 *
 * 安全：dsh client 插件与 dsh SPA 同为可信代码（≈ v1 扩展），不获得 core 通道；
 * 该 bundle 只用 fetch + DOM，不接触 owc 内部。
 */
window.__ModuleLoader__.load({
  id: "owc-dsh-bridge",
  // `require` 由模块系统注入：本桥接插件只用 fetch + DOM，故声明为未使用参数
  factory: (_require) => {
    const ID = "owc-dsh-bridge";
    const BUTTON_ID = "owc-dsh-bridge-home";

    /** 取 owc 事实（同源、带 cookie）；失败返回 undefined 并只写日志。 */
    async function fetchStatus() {
      try {
        const response = await fetch("/dsh-owc/status", { headers: { accept: "application/json" }, credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        console.warn("[owc-dsh-bridge] 读取 owc 状态失败：", error && error.message ? error.message : error);
        return undefined;
      }
    }

    /** 渲染右下角入口（幂等）。 */
    function renderButton(status) {
      if (typeof document === "undefined" || !status || typeof status.workbenchUrl !== "string" || status.workbenchUrl === "") return;
      let button = document.getElementById(BUTTON_ID);
      if (button === null) {
        button = document.createElement("a");
        button.id = BUTTON_ID;
        button.textContent = status.workbenchLabel === undefined ? "返回 Workbench" : status.workbenchLabel;
        button.setAttribute("rel", "noreferrer");
        button.style.cssText = [
          "position:fixed", "right:16px", "bottom:16px", "z-index:2147483000",
          "padding:6px 12px", "border-radius:999px", "font-size:12px", "line-height:1.4",
          "background:rgba(28,28,30,.86)", "color:#fff", "text-decoration:none",
          "box-shadow:0 2px 10px rgba(0,0,0,.28)", "backdrop-filter:blur(6px)",
        ].join(";");
        document.body.appendChild(button);
      }
      button.setAttribute("href", status.workbenchUrl);
    }

    /** cordis 插件体：v1 不依赖任何插槽服务，只做状态注入与入口渲染。 */
    function apply() {
      void fetchStatus().then((status) => {
        if (status === undefined) return;
        globalThis.__OWC_DSH__ = status;
        renderButton(status);
      });
    }

    return { apply, inject: [], name: ID };
  },
});
