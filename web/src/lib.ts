// Library entry: import to register <schema-explorer>, or use the exports directly.
export { SchemaExplorerElement, define } from "./element";
export type { Bundle, Component, Kind } from "./model";
export { Model } from "./model";
export { loadUrl, indexFiles } from "./loader";
import { define } from "./element";
define();
