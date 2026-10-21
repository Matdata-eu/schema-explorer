// What every view gets: the model, navigation, and small shared UI pieces.
import type { Compare } from "./diff";
import type { Id, Model } from "./model";

export interface Route {
  /** "home" | "comp" | "file" | "overview" | "missing" | "diff" | "diffc" (query: `slug/qname`) */
  view: string;
  id?: Id;
  /** Sub view of a page: "diagram" | "tree" */
  tab?: string;
  query?: string;
  /** Extra state in the URL (depth, direction...). */
  params: Record<string, string>;
}

export interface Prefs {
  theme: "light" | "dark" | "auto";
  showInherited: boolean;
  depth: 1 | 2;
  direction: "DOWN" | "RIGHT";
  enums: boolean;
  incoming: boolean;
}

export interface AppCtx {
  readonly m: Model;
  readonly route: Route;
  readonly prefs: Prefs;
  readonly embed: boolean;
  /** Compare mode: the earlier version and the diff to it (the model is the later version). */
  readonly cmp: Compare | null;
  go(id: Id, extra?: Partial<Route>): void;
  goRoute(r: Partial<Route>): void;
  href(id: Id, extra?: Partial<Route>): string;
  hrefRoute(r: Partial<Route>): string;
  setPrefs(p: Partial<Prefs>): void;
  toast(msg: string): void;
  /** Change the current route's parameters in place (no navigation), so the link always matches the view. */
  setParams(p: Record<string, string | undefined>): void;
  /** A link to the schema set and the current view; `complete` is false for local files. */
  shareLink(): { url: string; complete: boolean };
  /** Re-render the current page (after a preference change). */
  refresh(): void;
  /** The text of a schema file of the bundle, when it can be had. */
  sourceText(file: number): Promise<string | null>;
}
