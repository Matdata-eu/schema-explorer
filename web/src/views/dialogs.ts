// The "About" and "Help" dialogs. The help is a short manual, one foldable section
// per feature; controls are named by their label, not by where they sit on screen.
import { h, icon, type Child } from "../dom";

const REPO = "https://github.com/Matdata-eu/schema-explorer";

const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);
const b = (text: string) => h("strong", null, text);
const k = (text: string) => h("kbd", null, text);
const code = (text: string) => h("code", null, text);

/** A modal dialog with a title bar and a close button, added to `host`. */
function dialog(host: HTMLElement, title: string, cls: string, ...body: Child[]): HTMLDialogElement {
  const dlg = h("dialog", { class: `se-dialog ${cls}`, "aria-label": title }) as HTMLDialogElement;
  dlg.append(
    h("div", { class: "dlg-head" }, h("h2", null, title), h("button", { type: "button", class: "btn ghost icon-only", "aria-label": "Close", title: "Close", onClick: () => dlg.close() }, icon("close"))),
    h("div", { class: "dlg-body" }, ...body)
  );
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => dlg.remove());
  host.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

export function openAbout(host: HTMLElement, opts: { licensesUrl: string; generator?: string }): void {
  const dlg = dialog(
    host,
    "About schema-explorer",
    "about",
    h("p", null, "XML Schema (XSD) sets as UML-like diagrams, content-model trees and readable pages. The files are read and indexed in your browser; nothing is uploaded."),
    h("p", null, "New here? Read the ", h("button", { type: "button", class: "linkish", onClick: () => {
      dlg.close();
      openHelp(host);
    } }, "short guide"), "."),
    h("h3", null, "Feedback"),
    h("p", null, "Found a bug, missing a feature or have a question? Open an issue on ", link(`${REPO}/issues`, "GitHub"), ". Source code and documentation: ", link(REPO, REPO.replace(/^https:\/\//, "")), "."),
    h("p", { class: "muted small" }, "What a schema says comes from its authors and is shown as it is."),
    h("h3", null, "Credits"),
    h(
      "ul",
      { class: "credits" },
      h("li", null, "Schemas are read with ", link("https://github.com/RazrFalcon/roxmltree", "roxmltree"), " in Rust and WebAssembly; diagrams are laid out by the ", link("https://eclipse.dev/elk/", "Eclipse Layout Kernel")),
      h("li", null, "Fonts: ", link("https://github.com/jpt/barlow", "Barlow"), " and ", link("https://github.com/JetBrains/JetBrainsMono", "JetBrains Mono"), " (SIL Open Font License)"),
      h("li", null, "Example schemas belong to their publishers and keep their own licences"),
      h("li", null, "Full list: ", link(opts.licensesUrl, "third-party licences")),
      h("li", null, "Made by Mathias Vanden Auweele, ", link("https://matdata.eu", "MatData"), " · Apache License 2.0")
    ),
    h("p", { class: "muted small" }, `Version ${__APP_VERSION__}`, opts.generator ? ` · schemas indexed by ${opts.generator}` : "")
  );
}

const section = (title: string, open: boolean, ...items: Child[][]) => h("details", { class: "help-sec", open: open || undefined }, h("summary", null, title), h("ul", null, ...items.map((parts) => h("li", null, ...parts))));

export function openHelp(host: HTMLElement): void {
  dialog(
    host,
    "How to use schema-explorer",
    "help",
    h("p", { class: "muted" }, "Read an XML Schema set as diagrams, content-model trees and one page per type, element and group. Open a topic below."),
    section(
      "Getting started",
      true,
      ["Drop ", code(".xsd"), " files, JSON Schema, OpenAPI or AsyncAPI files (", code(".json"), ", ", code(".yaml"), ") or whole folders on the open page, or ", b("choose files"), " or ", b("choose a folder"), ". Give every file the schema imports, includes or names in a ", code("$ref"), ": they are found by their relative path, or else by file name or namespace."],
      ["Files are indexed in your browser (WebAssembly); nothing is uploaded. A bundle made with ", code("schema-explorer index"), " opens by its address, or with ", code("?bundle=<url>"), " added to this page's link."],
      [code("schema-explorer serve <files or folders>"), " opens the viewer on your own computer with the schemas already loaded."]
    ),
    section(
      "Finding things",
      false,
      ["Type in the ", b("search"), " box (", k("/"), " jumps to it) to match names of types, elements, attributes and groups, and words of their documentation and enumeration values. Use ", k("↑"), " ", k("↓"), " and ", k("Enter"), " to open a result."],
      ["The tabs under the search box list ", b("Types"), " (complex types), ", b("Simple"), " types, global ", b("Elements"), ", ", b("Groups"), " (model groups, attribute groups, global attributes) and ", b("Files"), ". The namespace list narrows them to one namespace."]
    ),
    section(
      "Type pages",
      false,
      ["The top card shows the ", b("derivation"), " chain (extension or restriction) up to the root, the derived types and the global elements of this type."],
      [b("Content model"), " lists the child elements in order with their type and cardinality. ", code("sequence"), ", ", code("choice"), " and ", code("all"), " appear as indented rows; group references are expanded under their name. Rows inherited from base types are grouped per base type and can be folded; ", b("inherited"), " shows or hides them."],
      [b("Attributes"), " lists every attribute, inherited and from attribute groups, with its type, use and default or fixed value."],
      [b("Where used"), " lists the types, elements and groups that refer to the type, and ", b("XSD source"), " (or ", b("JSON source"), ") shows the declaration as written, with links on the type names."]
    ),
    section(
      "Diagrams",
      false,
      ["The ", b("Diagram"), " draws the type as a UML class with its attributes (", code("@name"), ") and simple-typed child elements; complex-typed child elements are composition arrows (diamond) with their multiplicity. A hollow triangle is extension, a dashed one restriction. «enumeration» boxes list the values of enumerated types."],
      ["Click a box for options, double-click to add its neighbours. ", b("Depth"), " shows one or two steps around the type; ", b("Inherited"), ", ", b("Used by"), ", ", b("Derived"), " and ", b("Enumerations"), " add more."],
      ["The tree button flips the layout, ", b("Full screen"), " gives the diagram the whole screen (", k("Esc"), " to leave), and ", b("Export"), " saves SVG or PNG, or copies PlantUML or Mermaid."]
    ),
    section(
      "Content tree",
      false,
      ["The ", b("Content tree"), " shows the structure of an element or type as in XML editors: boxes are elements (dashed when optional, stacked when they repeat), the small three-dot node is a ", code("sequence"), " and the forked one a ", code("choice"), ". The occurrence is written under the box."],
      ["Click ", b("+"), " to open an element's content, or click the box to open its page or type. ", b("Expand 2 levels"), " and ", b("Collapse all"), " open and close many at once."]
    ),
    section(
      "Overview map",
      false,
      [b("Overview map"), " on the start page draws the complex types of a namespace by derivation. Narrow it to a folder of files, allow more boxes, or add ", b("Containment"), " arrows. Big namespaces show the most connected types first."]
    ),
    section(
      "Comparing versions",
      false,
      [b("Compare two versions"), " on the open page takes an earlier and a later schema set (or open ", code("?bundle=<new>&compare=<old>"), "). ", b("Changes"), " lists what was added (", code("+"), "), removed (", code("−"), ") and changed (", code("~"), "), with breaking changes flagged; filter it and export it as Markdown, HTML or JSON."],
      ["A changed component's page has four views. ", b("Changes"), " lists the changes and marks them on the later version's diagram. ", b("Side by side"), " shows each version's own diagram or content tree, left old and right new, laid out so matching boxes and rows sit at the same place, and the XSD source of both with the changed lines and words highlighted (", b("Unified"), " puts them in one column). ", b("Old"), " and ", b("New"), " show the whole normal page of either version."],
      ["Side by side, ", b("Linked"), " pans and zooms both sides together, double-clicking a box or opening a tree node does it on both sides, and each side has its own ", b("Export"), ". Links on the left lead to the earlier version's pages. Markers and struck-through text tell what differs without relying on colour."]
    ),
    section(
      "Sharing and display",
      false,
      [b("Share"), " copies a link to exactly this view: the schemas (when loaded from an address), the page, the tab, the diagram's options, the boxes you added, the open tree nodes and the zoom. The address bar always holds the same link."],
      ["Files opened from your computer are not part of the link; the link still opens the same page where the same files are loaded."],
      ["The moon and sun button switches between light and dark."]
    )
  );
}
