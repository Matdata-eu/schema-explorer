declare module "elkjs/lib/elk-api.js" {
  export interface ElkNode {
    id: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    children?: ElkNode[];
    edges?: ElkEdge[];
    layoutOptions?: Record<string, string>;
    labels?: { text: string; width?: number; height?: number; x?: number; y?: number }[];
  }
  export interface ElkEdge {
    id: string;
    sources: string[];
    targets: string[];
    sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[];
    labels?: { text: string; width?: number; height?: number; x?: number; y?: number }[];
    layoutOptions?: Record<string, string>;
  }
  export default class ELK {
    constructor(opts?: unknown);
    layout(graph: ElkNode): Promise<ElkNode>;
  }
}
declare module "elkjs/lib/elk-worker.min.js?url" {
  const url: string;
  export default url;
}
