import {
  Background,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react';
import { useEffect, useMemo } from 'react';

type Props<N extends Node> = {
  nodes: N[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The node the viewport centres on when the layout changes; without it the whole graph is fitted. */
  focusId?: string;
};

const FIT_ALL: FitViewOptions = { padding: 0.2 };

/** Centres one node at a readable zoom instead of fitting the whole graph. */
export const focusOn = (nodeId: string): FitViewOptions => ({ ...FIT_ALL, nodes: [{ id: nodeId }], maxZoom: 1 });

/** Nodes are derived, not owned by React Flow, so selection is painted from the page's state. */
const Canvas = <N extends Node>({ nodes, edges, nodeTypes, selectedId, onSelect, focusId }: Props<N>) => {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const painted = useMemo(() => nodes.map((node) => ({ ...node, selected: node.id === selectedId })) as N[], [nodes, selectedId]);
  const fit = useMemo(() => (focusId ? focusOn(focusId) : FIT_ALL), [focusId]);
  // The `fitView` prop covers the first paint. A layout with a different set of nodes re-fits once
  // React Flow has measured them and on the next frame: fitting while its resize observers are still
  // delivering trips "ResizeObserver loop completed with undelivered notifications". A refetch that
  // keeps the same nodes leaves the viewport alone so polling never yanks the canvas around.
  const shape = nodes.map((node) => node.id).join('|');
  useEffect(() => {
    if (!nodesInitialized) return;
    const frame = requestAnimationFrame(() => void fitView({ ...fit, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [fitView, fit, shape, nodesInitialized]);
  const onNodeClick: NodeMouseHandler<N> = (_event, node) => onSelect(node.id);
  return (
    <ReactFlow<N>
      nodes={painted}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      nodesDraggable={false}
      fitView
      fitViewOptions={fit}
      minZoom={0.3}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} />
    </ReactFlow>
  );
};

export const FlowCanvas = <N extends Node>(props: Props<N>) => (
  <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>
);
