// The start page of a schema set: size, namespaces, where to begin, problems.
import type { AppCtx } from "../ctx";
import { button, h, plural } from "../dom";
import type { Id } from "../model";
import { chips, section } from "./common";

export function homePage(ctx: AppCtx): HTMLElement {
  const m = ctx.m;
  const b = m.b;
  const st = b.stats;
  const page = h("div");
  page.appendChild(h("div", { class: "page-head" }, h("h1", null, m.title), h("span", { class: "badge" }, "XML Schema")));
  const inputs = b.files.filter((f) => f.input).map((f) => f.name);
  page.appendChild(h("p", { class: "muted small" }, `${plural(b.files.length, "file")}${inputs.length && inputs.length < b.files.length ? `, from ${inputs.slice(0, 3).join(", ")}${inputs.length > 3 ? ` and ${inputs.length - 3} more` : ""}` : ""} · indexed by ${b.generator}`));
  const g = st.global;
  const stat = (n: number | undefined, label: string, onClick?: () => void) => (n ? h("button", { class: "stat", type: "button", onClick }, h("div", { class: "n" }, n.toLocaleString()), h("div", { class: "l" }, label)) : null);
  page.appendChild(
    h(
      "div",
      { class: "stats" },
      stat(g.complexType, "complex types", () => ctx.goRoute({ view: "overview" })),
      stat(g.simpleType, "simple types"),
      stat(g.element, "global elements"),
      stat((g.group ?? 0) + (g.attributeGroup ?? 0), "groups"),
      stat(st.local.element, "local elements"),
      stat(st.enumerations, "enumeration values"),
      stat(b.files.length, "files")
    )
  );
  page.appendChild(section("Start here", { tools: [button("Overview map", () => ctx.goRoute({ view: "overview" }), { icon: "map", cls: "small" })] }));
  const roots = m.rootElements();
  if (roots.length) {
    page.appendChild(h("p", { class: "muted small" }, "Global elements nothing else refers to: the likely document roots."));
    page.appendChild(chips(ctx, roots, { max: 24 }));
  }
  const popular = m.lists.complexType
    .map((id) => ({ id, s: (m.c[id].usedBy?.length ?? 0) + (m.c[id].complexType?.derived?.length ?? 0) * 2 }))
    .sort((a, z) => z.s - a.s)
    .slice(0, 24)
    .map((x) => x.id as Id);
  if (popular.length) {
    page.appendChild(h("p", { class: "muted small" }, "The most used and most extended complex types."));
    page.appendChild(chips(ctx, popular, { max: 24 }));
  }
  // Namespaces.
  const counts = b.namespaces.map(() => ({ ct: 0, st: 0, el: 0 }));
  for (const id of m.lists.complexType) if (m.c[id].ns !== undefined) counts[m.c[id].ns!].ct++;
  for (const id of m.lists.simpleType) if (m.c[id].ns !== undefined) counts[m.c[id].ns!].st++;
  for (const id of m.lists.element) if (m.c[id].ns !== undefined) counts[m.c[id].ns!].el++;
  const nsRows = b.namespaces.map((n, i) => ({ n, i, c: counts[i] })).filter((x) => x.c.ct + x.c.st + x.c.el > 0);
  if (nsRows.length) {
    page.appendChild(section("Namespaces", { count: nsRows.length }));
    page.appendChild(
      h(
        "table",
        { class: "ptable compact" },
        h("thead", null, h("tr", null, h("th", null, "Prefix"), h("th", null, "Namespace"), h("th", null, "Complex"), h("th", null, "Simple"), h("th", null, "Elements"))),
        h("tbody", null, nsRows.map((x) => h("tr", null, h("td", { class: "mono" }, x.n.prefix), h("td", { class: "mono small" }, x.n.uri), h("td", null, h("a", { href: ctx.hrefRoute({ view: "overview", params: { ns: String(x.i) } }), onClick: (ev: Event) => {
          ev.preventDefault();
          ctx.goRoute({ view: "overview", params: { ns: String(x.i) } });
        }, title: "Map of this namespace" }, x.c.ct.toLocaleString())), h("td", null, x.c.st.toLocaleString()), h("td", null, x.c.el.toLocaleString()))))
      )
    );
  }
  const diags = (b.diagnostics ?? []).filter((d) => d.level !== "info");
  if (diags.length) {
    page.appendChild(section("Problems found while reading", { count: diags.length }));
    page.appendChild(
      h(
        "details",
        { class: "diags-box" },
        h("summary", { class: "muted" }, `${diags.filter((d) => d.level === "error").length} errors, ${diags.filter((d) => d.level === "warning").length} warnings`),
        h("ul", { class: "diags" }, diags.slice(0, 300).map((d) => h("li", { class: d.level }, h("span", { class: "badge" }, d.code), " ", d.file !== undefined ? h("span", { class: "mono small" }, `${b.files[d.file]?.name}:${d.line ?? ""} `) : null, d.message)))
      )
    );
  }
  return page;
}
