import { Background, type Edge, type FitViewOptions, type Node, type NodeMouseHandler, type NodeTypes, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';

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
const FOCUS_ZOOM = 1.5;

/** Centres one node at a readable zoom instead of fitting the whole graph. */
export const focusOn = (nodeId: string): FitViewOptions => ({ ...FIT_ALL, nodes: [{ id: nodeId }], maxZoom: FOCUS_ZOOM });

/** Nodes are derived, not owned by React Flow, so selection is painted from the page's state. */
const Canvas = <N extends Node>({ nodes, edges, nodeTypes, selectedId, onSelect, focusId }: Props<N>) => {
  const { fitView } = useReactFlow();
  const painted = useMemo(() => nodes.map((node) => ({ ...node, selected: node.id === selectedId })) as N[], [nodes, selectedId]);
  const fit = useMemo(() => (focusId ? focusOn(focusId) : FIT_ALL), [focusId]);
  // The `fitView` prop covers the first paint; the effect only re-fits when the set of nodes changes,
  // and React Flow itself defers the call until it has measured the new ones. A refetch that keeps
  // the same nodes leaves the viewport alone so polling never yanks the canvas around. Keying on the
  // shape rather than on `useNodesInitialized` matters: that flag flips only inside React Flow's
  // `setNodes`, i.e. on the first interaction after mount, and a re-fit there overrode whatever the
  // interaction (a "go to locale", a pan) had just asked for.
  const shape = nodes.map((node) => node.id).join('|');
  const fitted = useRef(shape);
  useEffect(() => {
    if (fitted.current === shape) return;
    fitted.current = shape;
    void fitView({ ...fit, duration: 200 });
  }, [fitView, fit, shape]);
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
