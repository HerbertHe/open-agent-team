import { useEffect, useRef } from 'react';
import { Graph, NodeEvent } from '@antv/g6';
import type { NodeData } from '@antv/g6';
import type { ObservabilityGraph } from '../types';
import type { AgentStatus } from '../types';

function roleFill(role: string, placeholder?: boolean): string {
  if (placeholder) return '#e6e6e6';
  if (role === 'admin') return '#722ed1';
  if (role === 'leader') return '#1677ff';
  if (role === 'worker') return '#52c41a';
  return '#8c8c8c';
}

function statusStroke(s: AgentStatus, placeholder?: boolean): string {
  if (placeholder) return '#8c8c8c';
  switch (s) {
    case 'busy':
      return '#fa8c16';
    case 'tool':
      return '#fadb14';
    case 'error':
      return '#f5222d';
    case 'done':
      return '#389e0d';
    default:
      return '#d9d9d9';
  }
}

export function AgentGraph({
  data,
  agentStatus,
  lastLogLineByAgent,
  onNodeClick,
}: {
  data: ObservabilityGraph | null;
  agentStatus: Record<string, AgentStatus>;
  lastLogLineByAgent: Record<string, string>;
  onNodeClick: (agentId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const onClickRef = useRef(onNodeClick);
  onClickRef.current = onNodeClick;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const graph = new Graph({
      container: el,
      autoFit: 'view',
      padding: 24,
      data: { nodes: [], edges: [] },
      layout: {
        type: 'dagre',
        rankdir: 'TB',
        align: 'UL',
        nodesep: 120,
        ranksep: 88,
        edgesep: 16,
      },
      node: {
        type: 'circle',
        style: {
          size: 64,
          labelText: (d: NodeData) => {
            const label = String(d.data?.label ?? d.id);
            const port = d.data?.port as number | undefined;
            const placeholder = Boolean(d.data?.placeholder);
            const log = d.data?.logPreview as string | undefined;
            const portStr =
              placeholder || port == null || port === 0 ? '' : `\n:${port}`;
            const logStr = log ? `\n${log}` : '';
            return `${label}${portStr}${logStr}`;
          },
          fill: (d: NodeData) =>
            roleFill(String(d.data?.role ?? ''), Boolean(d.data?.placeholder)),
          stroke: (d: NodeData) =>
            statusStroke(
              (d.data?.status as AgentStatus | undefined) ?? 'idle',
              Boolean(d.data?.placeholder)
            ),
          lineDash: (d: NodeData) => (d.data?.placeholder ? [4, 4] : undefined),
          lineWidth: 3,
          labelFontSize: 10,
          labelFill: '#262626',
          labelMaxWidth: 200,
          labelWordWrap: true,
        },
      },
      edge: {
        type: 'line',
        style: {
          stroke: '#bfbfbf',
          lineWidth: 1,
        },
      },
      behaviors: ['drag-canvas', 'zoom-canvas'],
    });

    graphRef.current = graph;
    void graph.render();

    const handler = (evt: { targetType?: string; target?: { id?: string } }) => {
      if (evt.targetType !== 'node') return;
      const id = evt.target?.id;
      if (id) onClickRef.current(String(id));
    };
    graph.on(NodeEvent.CLICK, handler as (e: unknown) => void);

    return () => {
      graph.off(NodeEvent.CLICK, handler);
      graph.destroy();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !data) return;

    const nodes = data.nodes.map((n) => ({
      id: n.id,
      data: {
        label: n.label,
        port: n.port,
        role: n.role,
        status: agentStatus[n.id] ?? 'idle',
        placeholder: n.placeholder,
        logPreview: lastLogLineByAgent[n.id],
      },
    }));

    const edges = data.edges.map((e, i) => ({
      id: `e-${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
    }));

    graph.setData({ nodes, edges });
    void graph.render();
  }, [data, agentStatus, lastLogLineByAgent]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 400,
        background: '#fafafa',
        borderRadius: 8,
      }}
    />
  );
}
