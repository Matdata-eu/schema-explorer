// Barlow and JetBrains Mono, self-hosted (SIL OFL 1.1). @font-face does not work
// inside a shadow root's stylesheet, so the faces are added to the document once.
import barlow400 from "@fontsource/barlow/files/barlow-latin-400-normal.woff2?url";
import barlow500 from "@fontsource/barlow/files/barlow-latin-500-normal.woff2?url";
import barlow600 from "@fontsource/barlow/files/barlow-latin-600-normal.woff2?url";
import barlow700 from "@fontsource/barlow/files/barlow-latin-700-normal.woff2?url";
import mono400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import mono500 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url";

const FACES: [string, number, string][] = [
  ["Barlow", 400, barlow400],
  ["Barlow", 500, barlow500],
  ["Barlow", 600, barlow600],
  ["Barlow", 700, barlow700],
  ["JetBrains Mono", 400, mono400],
  ["JetBrains Mono", 500, mono500],
];

let added = false;
export function addFonts(): void {
  if (added || typeof document === "undefined") return;
  added = true;
  if (document.querySelector("style[data-schema-explorer-fonts]")) return;
  const style = document.createElement("style");
  style.dataset.schemaExplorerFonts = "";
  style.textContent = FACES.map(
    ([family, weight, url]) =>
      `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(${JSON.stringify(url)}) format("woff2");}`,
  ).join("\n");
  document.head.appendChild(style);
}
