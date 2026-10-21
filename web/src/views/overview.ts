// The map of all complex types of a namespace (or a folder of files).
import type { AppCtx } from "../ctx";
import { Diagram } from "../diagram";
import { button, h } from "../dom";
import { buildOverview, folders, toMermaid, toPlantUml, type GraphSpec, type OverviewOptions } from "../graph";
import { boxActions, exportControls, fullscreenButton, parseView, viewParam } from "./diagramPanel";

export function overviewPage(ctx: AppCtx): HTMLElement {
  const m = ctx.m;
  const page = h("div");
  const nsList = m.namespacesOf("complexType").filter((x) => x.ns !== undefined || x.count > 0);
  const folderList = folders(m);
  const P = ctx.route.params;
  const nsParam = P.ns === undefined ? nsList[0]?.ns : P.ns === "" || P.ns === "all" ? undefined : Number(P.ns);
  const o: OverviewOptions = { ns: nsParam, folder: P.folder || undefined, associations: P.assoc === "1", maxNodes: Number(P.max) || 250 };
  let view = parseView(P.view);
  let restoreView = view !== undefined;
  const sync = () => ctx.setParams({ ns: o.ns === undefined ? "all" : String(o.ns), folder: o.folder, assoc: o.associations ? "1" : undefined, max: o.maxNodes !== 250 ? String(o.maxNodes) : undefined, view: viewParam(view ?? null) });
  page.appendChild(h("div", { class: "page-head" }, h("h1", null, "Overview map"), h("span", { class: "muted" }, "complex types and how they derive from each other")));
  const wrap = h("div", { class: "diagram tall" });
  const statusText = h("span");
  const status = h("div", { class: "status" }, statusText, h("div", { class: "legend hide-mobile" }, h("span", { class: "gen" }, "extends"), h("span", { class: "restr" }, "restricts"), h("span", { class: "comp" }, "contains")));
  const overlay = h("div", { class: "overlay" }, "Laying out the map… (large namespaces take a few seconds)");
  const d = new Diagram(wrap, { onNavigate: (id) => ctx.go(id), onExpand: (id) => ctx.go(id), nodeMenu: (id) => boxActions(ctx, id), onStatus: (t) => (statusText.textContent = t), onViewChange: (v) => {
    view = v ?? undefined;
    sync();
  } });
  let graph: GraphSpec | null = null;
  const run = () => {
    wrap.appendChild(overlay);
    graph = buildOverview(m, o);
    const algorithm = o.associations && graph.nodes.length > 80 ? "stress" : "layered";
    const start = restoreView ? view : undefined;
    restoreView = false;
    sync();
    const omitted = graph.omitted;
    d.render(graph, { direction: "DOWN", algorithm, view: start }).finally(() => {
      overlay.remove();
      if (omitted) statusText.textContent += ` · the ${o.maxNodes} most connected shown; pick a folder to see the rest`;
    });
  };
  const assocBtn = button("Containment", () => {
    o.associations = !o.associations;
    assocBtn.setAttribute("aria-pressed", String(o.associations));
    run();
  }, { cls: "small", pressed: o.associations, title: "Also draw which types contain which (child elements; slower)" });
  const nsSel = h("select", { class: "input sel" }, h("option", { value: "all" }, "All namespaces"), nsList.map((n) => h("option", { value: String(n.ns) }, `${n.ns === undefined ? "(no namespace)" : m.prefix(n.ns)} (${n.count})`))) as HTMLSelectElement;
  nsSel.value = o.ns === undefined ? "all" : String(o.ns);
  nsSel.addEventListener("change", () => {
    o.ns = nsSel.value === "all" ? undefined : Number(nsSel.value);
    run();
  });
  const folderSel = h("select", { class: "input sel" }, h("option", { value: "" }, "All folders"), folderList.map((f) => h("option", { value: f.folder }, `${f.folder} (${f.count})`))) as HTMLSelectElement;
  folderSel.value = o.folder ?? "";
  folderSel.addEventListener("change", () => {
    o.folder = folderSel.value || undefined;
    run();
  });
  const maxSel = h("select", { class: "input sel", title: "At most this many boxes" }, [100, 250, 500, 1000].map((n) => h("option", { value: String(n) }, `≤ ${n} boxes`))) as HTMLSelectElement;
  maxSel.value = String(o.maxNodes);
  maxSel.addEventListener("change", () => {
    o.maxNodes = Number(maxSel.value);
    run();
  });
  const { exportBtn, exportMenu } = exportControls(ctx, d, "overview", () => (graph ? { plantuml: toPlantUml(graph), mermaid: toMermaid(graph) } : null), wrap);
  const tools = h(
    "div",
    { class: "dtools" },
    nsList.length > 1 ? nsSel : null,
    folderList.length > 1 ? folderSel : null,
    maxSel,
    assocBtn,
    h("span", { class: "spacer" }),
    h("div", { class: "btn-group" }, button("", () => d.zoomBy(1.25), { cls: "small icon-only", icon: "plus", title: "Zoom in" }), button("", () => d.zoomBy(0.8), { cls: "small icon-only", icon: "minus", title: "Zoom out" }), button("", () => d.fit(), { cls: "small icon-only", icon: "fit", title: "Fit" })),
    fullscreenButton(wrap),
    exportBtn
  );
  wrap.append(tools, exportMenu, status);
  page.appendChild(wrap);
  page.appendChild(h("p", { class: "faint hint" }, "Derivation only by default. Click a type for its diagram or content tree. Big namespaces show the most connected types first; narrow the map to a folder of files to see the rest."));
  queueMicrotask(run);
  return page;
}
