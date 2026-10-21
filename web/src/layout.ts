// ELK (Eclipse Layout Kernel) runs in its own web worker; the main thread only holds the small API.
import ELK, { type ElkNode } from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";

let elk: ELK | null = null;

export function layout(graph: ElkNode): Promise<ElkNode> {
  if (!elk) elk = new ELK({ workerFactory: () => new Worker(workerUrl) });
  return elk.layout(graph);
}

export type { ElkNode };
