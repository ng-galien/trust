import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Circle, Clock3, Lock, RotateCcw, TerminalSquare, X, XCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { i18next } from "../../i18n/index.js";
import { cx, plural } from "../../lib/format.js";
import { useResolvedTheme } from "../../lib/preferences.js";
import type { CompiledProcedure, PlanCheck, ProcedureCheck } from "../../types.js";
import { IconButton } from "../../ui/button.js";
import { useOrigin } from "../shared/origin.js";
import { consumersOf, type DataLink, dataLinks, describeProvenance, downstreamOf, orderPrerequisites, providersOf, roleProvenance, upstreamOf } from "./dependencies.js";
import { orderedScenarios } from "./model.js";

/* Procedure graph — one card per Scenario, top to bottom in prerequisite order, its Checks inside.
   Two kinds of links: ORDER (a Scenario waits for its prerequisites, solid, centre) and DATA
   (a Check consumes a value another Check materialized, dashed, side arcs).
   Selecting a Check shows what it needs (upstream) and what a new verdict on it resets (downstream),
   exactly as the runtime cascades. With Plan checks the graph becomes the live execution diagram. */

interface ProcedureGraphProps {
  procedure: CompiledProcedure;
  checks?: PlanCheck[];
  selected?: string | undefined;
  onSelect?: (id: string | undefined) => void;
}

type Emphasis = "selected" | "upstream" | "downstream" | "dim" | undefined;
type LiveState = "satisfied" | "actionable" | "blocked" | "failed" | "open" | undefined;

interface CheckRow {
  id: string;
  name: string;
  operation: string;
  role: string | undefined;
  selection: string | undefined;
  establishes: string;
  state: LiveState;
  emphasis: Emphasis;
  /** Plan mode: one instance per target value when the Check expands ("each") — the parallel branches of the loop. */
  instances: Array<{ uri: string; value: string; state: LiveState }>;
  /** End of the hovered link. */
  highlight: boolean;
  /** Data handles on the right edge: consumes a value (in) / materializes one (out). */
  handles: { in: boolean; out: boolean };
}

interface ScenarioNodeData extends Record<string, unknown> {
  index: number;
  title: string;
  slug: string;
  after: string[];
  checks: CheckRow[];
  state: "complete" | "active" | "waiting" | "failed" | undefined;
  final: boolean;
  emphasis: Emphasis;
  /** End of the hovered order link. */
  highlight: boolean;
  onSelect?: ((id: string | undefined) => void) | undefined;
}

/** Shared by both edge kinds: hover/selection plumbing and the plain-language reading of the link. */
interface EdgeCommon {
  id: string;
  explain: ReactNode;
  hovered: boolean;
  focus: boolean;
  onHover?: ((id: string | undefined) => void) | undefined;
  onSelect?: ((id: string | undefined) => void) | undefined;
}

interface DataEdgeData extends Record<string, unknown>, EdgeCommon {
  label: string;
  emphasis: Emphasis;
  /** Orthogonal route: exit right, run down a lane on the right of the diagram, enter the consumer from the right.
      Cards with a right-hand neighbour leave/enter through the column gap and the row channel instead. */
  laneX: number;
  /** Label position along the lane, chosen so labels of neighbouring lanes never overlap. */
  labelY: number;
  providerGapX: number | null;
  consumerGapX: number | null;
  providerRow: string[];
  consumerRow: string[];
}

interface OrderEdgeData extends Record<string, unknown>, EdgeCommon {
  emphasis: Emphasis;
  done: boolean;
  /** Set when the edge skips rows: it bypasses them through a lane on the left of the diagram. */
  bypassX?: number;
  sourceRow?: string[];
  targetRow?: string[];
}

const nodeTypes = { scenario: ScenarioNode };
const edgeTypes = { data: DataEdge, order: OrderEdge };
const NODE_WIDTH = 340;
const COLUMN_GAP = 96;
const ROW_GAP = 64;
const HEADER_HEIGHT = 58;
const CHECK_HEIGHT = 72;
const FOOTER_HEIGHT = 12;
const LANE_START = 56;
const LANE_GAP = 34;
const LABEL_HEIGHT = 18;
const CORNER = 8;

export function ProcedureGraph({ procedure, checks = [], selected, onSelect }: ProcedureGraphProps) {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  // Measured card heights feed back into the layout (titles wrap): rows never overlap the gaps.
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setMeasured((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type === "dimensions" && change.dimensions && current[change.id] !== change.dimensions.height) {
          if (next === current) next = { ...current };
          next[change.id] = change.dimensions.height;
        }
      }
      return next;
    });
  }, []);
  const [hovered, setHovered] = useState<string>();
  const base = useMemo(() => layout(procedure, checks, selected, onSelect, measured, setHovered), [procedure, checks, selected, onSelect, measured]);
  // Hover only touches the hovered edge and its two ends: everything else keeps its identity (no full re-render).
  const { nodes, edges } = useMemo(() => applyHover(base, hovered, procedure), [base, hovered, procedure]);
  const selectedNodeId = useMemo(() => {
    if (!selected) return undefined;
    if (selected.startsWith("scenario:")) return selected;
    const check = procedure.checks.find((candidate) => `check:${candidate.name}` === selected);
    return check ? `scenario:${check.scenario}` : undefined;
  }, [selected, procedure]);

  return (
    <div className="flex h-full w-full bg-bg" aria-label={t("procedures.graph.ariaLabel", { title: procedure.title })}>
      <div className="relative min-w-0 flex-1">
      <ReactFlow
        key={procedure.definitionDigest}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={theme}
        onInit={(instance) => {
          // Fit the width at a readable zoom, then start from the top: a tall diagram is scrolled, not shrunk.
          void instance.fitView({ padding: { top: 0.05, bottom: 0.05, left: "120px", right: "240px" }, minZoom: 0.75, maxZoom: 1 }).then(() => {
            const viewport = instance.getViewport();
            void instance.setViewport({ ...viewport, y: 48 });
          });
        }}
        onPaneClick={() => onSelect?.(undefined)}
        onEdgeMouseEnter={(_, edge) => setHovered(edge.id)}
        onEdgeMouseLeave={() => setHovered(undefined)}
        onEdgeClick={(_, edge) => onSelect?.(`edge:${edge.id}`)}
        // Nodes are neither draggable nor selectable by xyflow; a click handler keeps them interactive (pointer events on).
        onNodeClick={() => undefined}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Markers />
        <Background gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ width: 132, height: 110 }}
          className="!bg-surface !border !border-border !rounded-(--radius-2)"
          nodeBorderRadius={4}
          nodeStrokeWidth={0}
          nodeColor={(node) => minimapColor((node.data as ScenarioNodeData | undefined)?.emphasis)}
          maskColor="var(--minimap-mask)"
          maskStrokeColor="var(--color-accent)"
          maskStrokeWidth={2}
        />
        <EnsureVisible nodeId={selectedNodeId} />
        <KeepCentered />
      </ReactFlow>
      <Legend selection={Boolean(selected)} />
      </div>
      {selected ? <SelectionPanel procedure={procedure} selected={selected} onSelect={onSelect} /> : null}
    </div>
  );
}

/* ---------- layout ---------- */

function layout(procedure: CompiledProcedure, planChecks: PlanCheck[], selected: string | undefined, onSelect: ProcedureGraphProps["onSelect"], measured: Record<string, number>, onHover: (id: string | undefined) => void) {
  // A Check name may expand into several Plan Checks (one per "each" value): aggregate them, keep the instances.
  const live = new Map<string, LiveState>();
  const instancesOf = new Map<string, Array<{ uri: string; value: string; state: LiveState }>>();
  for (const check of planChecks) {
    const state: LiveState = check.state === "SATISFIED" ? "satisfied"
      : check.latestVerdict === "NOT_VALIDATED" ? "failed"
      : check.actionable ? "actionable"
      : check.blockedBy.length ? "blocked" : "open";
    const previous = live.get(check.name);
    const rank: Record<NonNullable<LiveState>, number> = { failed: 5, actionable: 4, open: 3, blocked: 2, satisfied: 1 };
    live.set(check.name, previous && rank[previous] >= rank[state] ? previous : state);
    instancesOf.set(check.name, [...(instancesOf.get(check.name) ?? []), { uri: check.checkUri, value: String(check.target.value), state }]);
  }
  const levels = scenarioLevels(procedure);
  const dependents = new Set(procedure.scenarios.flatMap((scenario) => scenario.dependencies));
  const rows = new Map<number, string[]>();
  for (const scenario of procedure.scenarios) {
    const level = levels.get(scenario.slug) ?? 0;
    rows.set(level, [...(rows.get(level) ?? []), scenario.slug]);
  }
  const heights = new Map(procedure.scenarios.map((scenario) => [scenario.slug, measured[`scenario:${scenario.slug}`] ?? (HEADER_HEIGHT + Math.max(1, scenario.checks.length) * CHECK_HEIGHT + scenario.checks.reduce((sum, name) => sum + ((instancesOf.get(name)?.length ?? 0) > 1 ? 24 : 0), 0) + FOOTER_HEIGHT)]));
  const rowTop = new Map<number, number>();
  let y = 0;
  const levelKeys = Array.from(rows.keys()).sort((a, b) => a - b);
  for (const level of levelKeys) {
    rowTop.set(level, y);
    const tallest = Math.max(...(rows.get(level) ?? []).map((slug) => heights.get(slug) ?? HEADER_HEIGHT));
    y += tallest + ROW_GAP;
  }
  const widest = Math.max(1, ...levelKeys.map((level) => rows.get(level)?.length ?? 1));
  const totalWidth = widest * NODE_WIDTH + (widest - 1) * COLUMN_GAP;

  const scenarioOf = new Map(procedure.checks.map((check) => [check.name, check.scenario]));
  const links = dataLinks(procedure);
  const emphasis = emphasisModel(procedure, selected);
  const selectedEdge = selected?.startsWith("edge:") ? selected.slice("edge:".length) : undefined;
  const titleOf = (slug: string) => procedure.scenarios.find((scenario) => scenario.slug === slug)?.title ?? slug;

  // Geometry per scenario card: x, right edge, the column gap on its right (when a sibling follows), its row.
  const geometry = new Map<string, { x: number; right: number; gapX: number | null; row: string[]; top: number }>();
  for (const scenario of procedure.scenarios) {
    const level = levels.get(scenario.slug) ?? 0;
    const siblings = rows.get(level) ?? [scenario.slug];
    const column = siblings.indexOf(scenario.slug);
    const rowWidth = siblings.length * NODE_WIDTH + (siblings.length - 1) * COLUMN_GAP;
    const x = (totalWidth - rowWidth) / 2 + column * (NODE_WIDTH + COLUMN_GAP);
    geometry.set(scenario.slug, {
      x,
      right: x + NODE_WIDTH,
      gapX: column < siblings.length - 1 ? x + NODE_WIDTH + COLUMN_GAP / 2 : null,
      row: siblings.map((slug) => `scenario:${slug}`),
      top: rowTop.get(level) ?? 0,
    });
  }
  // Approximate y of a Check row (for lane assignment only; the drawn route uses measured handles).
  const rowY = (name: string) => {
    const scenario = procedure.scenarios.find((candidate) => candidate.checks.includes(name));
    const geo = scenario ? geometry.get(scenario.slug) : undefined;
    const index = scenario?.checks.indexOf(name) ?? 0;
    return (geo?.top ?? 0) + HEADER_HEIGHT + index * CHECK_HEIGHT + CHECK_HEIGHT / 2;
  };
  // Lanes: overlapping vertical spans get distinct lanes (greedy interval colouring, longest spans outermost).
  const spans = links.map((link) => ({ link, start: rowY(link.from), end: rowY(link.to) })).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const lanes = new Map<DataLink, number>();
  const active: Array<{ end: number; lane: number }> = [];
  for (const span of spans) {
    for (let index = active.length - 1; index >= 0; index -= 1) if (active[index]!.end <= span.start) active.splice(index, 1);
    let lane = 0;
    while (active.some((entry) => entry.lane === lane)) lane += 1;
    lanes.set(span.link, lane);
    active.push({ end: span.end, lane });
  }
  // Labels: mid-lane by default, pushed down (then up) while they collide with an already placed neighbour.
  const labelWidth = (text: string) => 26 + text.length * 6.2;
  const placed: Array<{ x: number; y: number; w: number }> = [];
  const labelYOf = new Map<DataLink, number>();
  for (const span of spans) {
    const x = totalWidth + LANE_START + (lanes.get(span.link) ?? 0) * LANE_GAP;
    const w = labelWidth(span.link.role ?? span.link.field ?? "");
    const lo = Math.min(span.start, span.end) + LABEL_HEIGHT;
    const hi = Math.max(span.start, span.end) - LABEL_HEIGHT;
    const collides = (y: number) => placed.some((other) => Math.abs(other.x - x) < (other.w + w) / 2 && Math.abs(other.y - y) < LABEL_HEIGHT);
    let y = (span.start + span.end) / 2;
    if (collides(y)) {
      let candidate: number | undefined;
      for (let step = 1; step < 40 && candidate === undefined; step += 1) {
        const down = y + step * LABEL_HEIGHT;
        const up = y - step * LABEL_HEIGHT;
        if (down <= hi && !collides(down)) candidate = down;
        else if (up >= lo && !collides(up)) candidate = up;
      }
      y = candidate ?? y;
    }
    placed.push({ x, y, w });
    labelYOf.set(span.link, y);
  }
  // Order links that skip rows bypass them on the left; same lane discipline.
  const skipping = procedure.scenarios.flatMap((scenario) => scenario.dependencies
    .filter((dependency) => (levels.get(scenario.slug) ?? 0) - (levels.get(dependency) ?? 0) > 1)
    .map((dependency) => ({ key: `${dependency}->${scenario.slug}`, start: geometry.get(dependency)?.top ?? 0, end: geometry.get(scenario.slug)?.top ?? 0 })))
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const bypassLanes = new Map<string, number>();
  const activeBypass: Array<{ end: number; lane: number }> = [];
  for (const span of skipping) {
    for (let index = activeBypass.length - 1; index >= 0; index -= 1) if (activeBypass[index]!.end <= span.start) activeBypass.splice(index, 1);
    let lane = 0;
    while (activeBypass.some((entry) => entry.lane === lane)) lane += 1;
    bypassLanes.set(span.key, lane);
    activeBypass.push({ end: span.end, lane });
  }

  const nodes: Node<ScenarioNodeData>[] = [];
  const edges: Edge[] = [];
  procedure.scenarios.forEach((scenario, index) => {
    const geo = geometry.get(scenario.slug)!;
    const checkRows: CheckRow[] = scenario.checks.map((name) => {
      const check = procedure.checks.find((candidate) => candidate.name === name);
      const state: LiveState = live.get(name);
      const inbound = links.filter((link) => link.to === name);
      const outbound = links.filter((link) => link.from === name);
      return {
        id: `check:${name}`,
        name,
        operation: check?.operation ?? "",
        role: check?.target?.role,
        selection: check?.target?.selection,
        establishes: check?.successReason ?? "",
        state,
        emphasis: emphasis.check(name),
        instances: (instancesOf.get(name)?.length ?? 0) > 1 ? instancesOf.get(name)! : [],
        highlight: false,
        handles: { in: inbound.length > 0, out: outbound.length > 0 },
      };
    });
    const state = planChecks.length === 0 ? undefined
      : checkRows.every((row) => row.state === "satisfied") ? "complete"
      : checkRows.some((row) => row.state === "failed") ? "failed"
      : checkRows.some((row) => row.state === "actionable") ? "active" : "waiting";
    nodes.push({
      id: `scenario:${scenario.slug}`,
      type: "scenario",
      position: { x: geo.x, y: geo.top },
      data: {
        index,
        title: scenario.title,
        slug: scenario.slug,
        after: scenario.dependencies.map((dependency) => procedure.scenarios.find((entry) => entry.slug === dependency)?.title ?? dependency),
        checks: checkRows,
        state,
        final: !dependents.has(scenario.slug),
        emphasis: emphasis.scenario(scenario.slug, checkRows.map((row) => row.emphasis)),
        highlight: false,
        onSelect,
      },
      // Dimensions are declared up front (nodes are controlled, measurements never flow back): minimap and fitView rely on them.
      initialWidth: NODE_WIDTH,
      initialHeight: heights.get(scenario.slug) ?? HEADER_HEIGHT,
      draggable: false,
      selectable: false,
    });
    for (const dependency of scenario.dependencies) {
      const from = procedure.scenarios.find((entry) => entry.slug === dependency);
      const fromComplete = from ? from.checks.every((name) => live.get(name) === "satisfied") : false;
      const tone = emphasis.order(dependency, scenario.slug);
      const orderId = `order:${dependency}->${scenario.slug}`;
      const resetsBelow = downstreamOf(procedure, from?.checks ?? []).size;
      edges.push({
        id: orderId,
        source: `scenario:${dependency}`,
        target: `scenario:${scenario.slug}`,
        sourceHandle: "order-out",
        targetHandle: "order-in",
        type: "order",
        markerEnd: markerFor(tone, "order", planChecks.length > 0 && fromComplete ? "done" : undefined, selectedEdge === orderId),
        animated: planChecks.length > 0 && !fromComplete,
        className: cx("edge-order", edgeClass(tone), planChecks.length > 0 && fromComplete && "edge-done", selectedEdge === orderId && "edge-focus"),
        data: {
          id: orderId,
          explain: readOrderEdge(titleOf(dependency), scenario.title, resetsBelow),
          hovered: false,
          focus: selectedEdge === orderId,
          onHover,
          onSelect,
          emphasis: tone,
          done: planChecks.length > 0 && fromComplete,
          ...(bypassLanes.has(`${dependency}->${scenario.slug}`) ? {
            bypassX: -LANE_START - (bypassLanes.get(`${dependency}->${scenario.slug}`) ?? 0) * LANE_GAP,
            sourceRow: geometry.get(dependency)?.row ?? [],
            targetRow: geometry.get(scenario.slug)?.row ?? [],
          } : {}),
        } satisfies OrderEdgeData,
        zIndex: selectedEdge === orderId ? 2 : tone === "upstream" || tone === "downstream" ? 1 : 0,
        focusable: false,
        selectable: false,
      });
    }
  });
  for (const link of links) {
    const tone = emphasis.data(link.from, link.to);
    const provider = geometry.get(scenarioOf.get(link.from) ?? "");
    const consumer = geometry.get(scenarioOf.get(link.to) ?? "");
    const dataId = dataEdgeId(link);
    const resetsBelow = downstreamOf(procedure, [link.from]).size - 1;
    edges.push({
      id: dataId,
      source: `scenario:${scenarioOf.get(link.from) ?? ""}`,
      target: `scenario:${scenarioOf.get(link.to) ?? ""}`,
      sourceHandle: `out:${link.from}`,
      targetHandle: `in:${link.to}`,
      type: "data",
      markerEnd: markerFor(tone, "data"),
      className: cx("edge-data", edgeClass(tone), selectedEdge === dataId && "edge-focus"),
      data: {
        id: dataId,
        explain: readDataEdge(link, resetsBelow),
        hovered: false,
        focus: selectedEdge === dataId,
        onHover,
        onSelect,
        label: link.role ?? link.field ?? i18next.t("procedures.graph.edge.fieldFallback"),
        emphasis: tone,
        laneX: totalWidth + LANE_START + (lanes.get(link) ?? 0) * LANE_GAP,
        labelY: labelYOf.get(link) ?? rowY(link.from),
        providerGapX: provider?.gapX ?? null,
        consumerGapX: consumer?.gapX ?? null,
        providerRow: provider?.row ?? [],
        consumerRow: consumer?.row ?? [],
      } satisfies DataEdgeData,
      zIndex: selectedEdge === dataId ? 2 : tone === "upstream" || tone === "downstream" ? 1 : 0,
      focusable: false,
      selectable: false,
    });
  }
  return { nodes, edges };
}

/* DSL-styled prose: the same tokens as the Gherkin editor (type / string / verb), so an edge reads like its source line. */
const Kw = ({ children }: { children: ReactNode }) => <span className="font-semibold" style={{ color: "var(--color-editor-type)" }}>{children}</span>;
const Str = ({ children }: { children: ReactNode }) => <span className="mono" style={{ color: "var(--color-editor-string)" }}>“{children}”</span>;
const Verb = ({ children }: { children: ReactNode }) => <em style={{ color: "var(--color-editor-verb)" }}>{children}</em>;

function readDataEdge(link: DataLink, resetsBelow: number): ReactNode {
  return (
    <>
      <Kw>Check</Kw> <Str>{link.to}</Str>{" "}
      {link.role
        ? <><Verb>uses</Verb> <Str>{link.role}</Str>{link.input ? <> <Verb>as</Verb> <Kw>Input</Kw> <Str>{link.input}</Str></> : null}, <Verb>materialized by</Verb></>
        : <><Verb>expects field</Verb> <Str>{link.field ?? ""}</Str> <Verb>of</Verb></>}{" "}
      <Kw>Check</Kw> <Str>{link.from}</Str>.
      <span className="mt-1 block text-muted">
        {i18next.t("procedures.graph.edge.newVerdictOn")} <Str>{link.from}</Str> <Verb>resets</Verb> <Str>{link.to}</Str>{resetsBelow > 0 ? <> {i18next.t("procedures.graph.edge.andOthersBelow", { count: resetsBelow })}</> : null}.
      </span>
    </>
  );
}

function readOrderEdge(fromTitle: string, toTitle: string, resetsBelow: number): ReactNode {
  return (
    <>
      <Kw>Scenario</Kw> <Str>{toTitle}</Str> <Verb>waits for</Verb> <Kw>Scenario</Kw> <Str>{fromTitle}</Str> <Verb>is validated</Verb>.
      <span className="mt-1 block text-muted">
        {i18next.t("procedures.graph.edge.newVerdictIn")} <Str>{fromTitle}</Str> <Verb>resets</Verb> {i18next.t("procedures.graph.edge.checksBelowIt", { count: resetsBelow })}
      </span>
    </>
  );
}

/** Overlay the hover state on a computed layout, touching only the hovered edge and its ends. */
function applyHover(base: { nodes: Node<ScenarioNodeData>[]; edges: Edge[] }, hovered: string | undefined, procedure: CompiledProcedure) {
  if (!hovered) return base;
  const ref = findEdge(procedure, hovered);
  if (!ref) return base;
  const checkEnds = new Set(ref.kind === "data" ? [ref.from, ref.to] : []);
  const scenarioEnds = new Set(ref.kind === "order" ? [`scenario:${ref.from}`, `scenario:${ref.to}`] : []);
  const nodes = base.nodes.map((node) => {
    const rows = node.data.checks;
    const touchesRow = rows.some((row) => checkEnds.has(row.name));
    if (!touchesRow && !scenarioEnds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        highlight: scenarioEnds.has(node.id),
        checks: touchesRow ? rows.map((row) => (checkEnds.has(row.name) ? { ...row, highlight: true } : row)) : rows,
      },
    };
  });
  const edges = base.edges.map((edge): Edge => {
    if (edge.id !== hovered) return edge;
    const data = edge.data as (OrderEdgeData | DataEdgeData) | undefined;
    const lit: Edge = {
      ...edge,
      className: cx(edge.className, "edge-hover"),
      zIndex: 2,
      ...(ref.kind === "order" ? { markerEnd: "url(#trust-arrow-focus)" } : {}),
      ...(data ? { data: { ...data, hovered: true } } : {}),
    };
    return lit;
  });
  return { nodes, edges };
}

function dataEdgeId(link: DataLink): string {
  return `data:${link.from}->${link.to}:${link.role ?? link.field ?? ""}`;
}

type EdgeRef = { kind: "order"; from: string; to: string } | { kind: "data"; from: string; to: string; link: DataLink };

/** Resolve an edge id (order:… / data:…) against the procedure — no string parsing of names. */
function findEdge(procedure: CompiledProcedure, id: string): EdgeRef | undefined {
  for (const scenario of procedure.scenarios) {
    for (const dependency of scenario.dependencies) {
      if (`order:${dependency}->${scenario.slug}` === id) return { kind: "order", from: dependency, to: scenario.slug };
    }
  }
  const link = dataLinks(procedure).find((candidate) => dataEdgeId(candidate) === id);
  return link ? { kind: "data", from: link.from, to: link.to, link } : undefined;
}

/** Selection → emphasis of every Check, Scenario and link. */
function emphasisModel(procedure: CompiledProcedure, selected: string | undefined) {
  if (!selected) {
    return {
      check: (): Emphasis => undefined,
      scenario: (): Emphasis => undefined,
      order: (): Emphasis => undefined,
      data: (): Emphasis => undefined,
    };
  }
  const edge = selected.startsWith("edge:") ? findEdge(procedure, selected.slice("edge:".length)) : undefined;
  // An edge reads as "what happens from its source": seeds are the source Check(s).
  const seeds = edge
    ? (edge.kind === "data" ? [edge.from] : (procedure.scenarios.find((scenario) => scenario.slug === edge.from)?.checks ?? []))
    : selected.startsWith("scenario:")
      ? (procedure.scenarios.find((scenario) => `scenario:${scenario.slug}` === selected)?.checks ?? [])
      : procedure.checks.filter((check) => `check:${check.name}` === selected).map((check) => check.name);
  const seedSet = new Set(seeds);
  const up = upstreamOf(procedure, seeds);
  const down = downstreamOf(procedure, seeds);
  const scenarioOf = (name: string) => procedure.checks.find((check) => check.name === name)?.scenario ?? "";
  const upScenarios = new Set([...seeds, ...up].map(scenarioOf));
  const downScenarios = new Set([...seeds, ...down].map(scenarioOf));
  const selectedScenario = selected.startsWith("scenario:") ? selected.slice("scenario:".length) : undefined;
  return {
    check: (name: string): Emphasis => (seedSet.has(name) ? "selected" : up.has(name) ? "upstream" : down.has(name) ? "downstream" : "dim"),
    scenario: (slug: string, rowEmphasis: Emphasis[]): Emphasis =>
      slug === selectedScenario ? "selected" : rowEmphasis.every((entry) => entry === "dim") ? "dim" : undefined,
    order: (from: string, to: string): Emphasis =>
      upScenarios.has(from) && upScenarios.has(to) ? "upstream" : downScenarios.has(from) && downScenarios.has(to) ? "downstream" : "dim",
    data: (from: string, to: string): Emphasis => {
      const upSet = new Set([...seeds, ...up]);
      const downSet = new Set([...seeds, ...down]);
      return upSet.has(from) && upSet.has(to) ? "upstream" : downSet.has(from) && downSet.has(to) ? "downstream" : "dim";
    },
  };
}

function minimapColor(tone: Emphasis): string {
  if (tone === "selected") return "var(--color-accent)";
  if (tone === "dim") return "var(--color-surface-3)";
  return "var(--color-border-strong)";
}

function edgeClass(tone: Emphasis): string {
  return tone === "upstream" ? "edge-up" : tone === "downstream" ? "edge-down" : tone === "dim" ? "edge-dim" : "";
}

function markerFor(tone: Emphasis, kind: "order" | "data", live?: "done", lit = false): string {
  if (lit && kind === "order") return "url(#trust-arrow-focus)";
  if (tone === "upstream") return "url(#trust-arrow-up)";
  if (tone === "downstream") return "url(#trust-arrow-down)";
  if (live === "done") return "url(#trust-arrow-done)";
  return kind === "data" ? "url(#trust-arrow-data)" : "url(#trust-arrow)";
}

/** Arrowheads coloured by CSS tokens (xyflow's built-in markers cannot take token colours per edge). */
function Markers() {
  const marker = (id: string, className: string) => (
    <marker id={id} viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d="M 1 1.5 L 13 7 L 1 12.5 z" className={className} />
    </marker>
  );
  return (
    <svg aria-hidden="true" style={{ position: "absolute", width: 0, height: 0 }}>
      <defs>
        {marker("trust-arrow", "arrow-neutral")}
        {marker("trust-arrow-data", "arrow-data")}
        {marker("trust-arrow-up", "arrow-up")}
        {marker("trust-arrow-down", "arrow-down")}
        {marker("trust-arrow-done", "arrow-done")}
        {marker("trust-arrow-focus", "arrow-focus")}
      </defs>
    </svg>
  );
}

/* ---------- nodes ---------- */

function ScenarioNode({ data }: NodeProps<Node<ScenarioNodeData>>) {
  const { t } = useTranslation();
  const origin = useOrigin();
  const tone =
    data.state === "complete" ? "border-success/60" : data.state === "failed" ? "border-danger/60" : data.state === "active" ? "border-accent/70" : "border-border";
  return (
    <div
      className={cx(
        "rounded-(--radius-3) border bg-surface text-text shadow-(--shadow-2) transition-opacity",
        tone,
        data.emphasis === "selected" && "ring-2 ring-accent/60",
        data.highlight && "ring-2 ring-accent",
        data.emphasis === "dim" && "opacity-35",
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle id="order-in" type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-border-strong" />
      <button
        type="button"
        onClick={() => data.onSelect?.(`scenario:${data.slug}`)}
        className="flex w-full items-start gap-2 rounded-t-(--radius-3) px-3 py-2 text-left hover:bg-surface-2"
        title={t("procedures.graph.node.selectScenario")}
      >
        <span className={cx("mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold", data.state === "complete" ? "bg-success text-accent-contrast" : data.state === "active" ? "bg-accent text-accent-contrast" : data.state === "failed" ? "bg-danger text-accent-contrast" : "bg-surface-3 text-muted")}>
          {data.state === "complete" ? <CheckCircle2 size={12} /> : data.index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-semibold leading-tight" title={data.title}>{data.title}</span>
          <span className="block truncate text-meta text-muted" title={data.after.length ? t("procedures.graph.node.after", { list: data.after.join(", ") }) : t("procedures.graph.node.entryPoint")}>
            {data.after.length ? t("procedures.graph.node.after", { list: data.after.join(", ") }) : t("procedures.graph.node.entryPoint")}
            {data.final ? t("procedures.graph.node.final") : ""}
          </span>
        </span>
        {data.state ? <span className={cx("shrink-0 rounded-(--radius-1) px-1.5 py-0.5 text-micro font-semibold uppercase tracking-[0.05em]", data.state === "complete" ? "bg-success-soft text-success" : data.state === "active" ? "bg-accent-soft text-accent" : data.state === "failed" ? "bg-danger-soft text-danger" : "bg-surface-3 text-muted")}>{t(`procedures.graph.node.state.${data.state}`)}</span> : null}
      </button>
      <ul className="border-t border-border">
        {data.checks.map((check) => (
          <li key={check.id} className="relative">
            <button
              type="button"
              onClick={() => data.onSelect?.(check.id)}
              className={cx(
                "flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2",
                check.emphasis === "selected" && "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)] hover:bg-accent-soft",
                check.emphasis === "upstream" && "bg-info-soft/60 shadow-[inset_3px_0_0_var(--color-info)]",
                check.emphasis === "downstream" && "bg-graph-data-soft/70 shadow-[inset_3px_0_0_var(--color-graph-data)]",
                check.emphasis === "dim" && "opacity-40",
                check.highlight && "outline-2 -outline-offset-2 outline-accent",
              )}
              style={{ minHeight: CHECK_HEIGHT }}
              title={check.emphasis === "downstream" ? t("procedures.graph.node.resetByVerdict") : check.emphasis === "upstream" ? t("procedures.graph.node.neededBySelected") : t("procedures.graph.node.selectCheck")}
            >
              <span className="mt-0.5 shrink-0">
                {check.state === "satisfied" ? <CheckCircle2 size={13} className="text-success" />
                  : check.state === "failed" ? <XCircle size={13} className="text-danger" />
                  : check.state === "actionable" ? <Circle size={13} className="text-accent" />
                  : check.state === "blocked" ? <Lock size={13} className="text-faint" />
                  : check.state === "open" ? <Clock3 size={13} className="text-muted" />
                  : <Circle size={13} className="text-faint" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="mono truncate text-body font-medium" title={check.name}>{check.name}</span>
                  {check.emphasis === "downstream" ? <span className="ml-auto shrink-0 rounded-(--radius-1) bg-graph-data-soft px-1 text-micro font-semibold uppercase tracking-[0.05em] text-graph-data">{t("procedures.graph.node.resets")}</span> : null}
                  {check.emphasis === "upstream" ? <span className="ml-auto shrink-0 rounded-(--radius-1) bg-info-soft px-1 text-micro font-semibold uppercase tracking-[0.05em] text-info">{t("procedures.graph.node.needed")}</span> : null}
                </span>
                <span className="flex items-baseline gap-2 text-meta text-muted">
                  {check.role ? <span className="truncate" title={check.selection === "each" ? t("procedures.graph.node.onEachRole", { role: check.role }) : t("procedures.graph.node.onRole", { role: check.role })}>{check.selection === "each" ? t("procedures.graph.node.onEach") : t("procedures.graph.node.on")} <span className="text-text">{check.role}</span></span> : <span />}
                  <Link
                    to={`/operations/${encodeURIComponent(check.operation)}`}
                    state={origin}
                    onClick={(event) => event.stopPropagation()}
                    className="mono ml-auto inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
                    title={t("procedures.graph.node.openOperation", { operation: check.operation })}
                  >
                    <TerminalSquare size={10} /> {check.operation}
                  </Link>
                </span>
                {check.establishes ? <span className="block truncate text-meta leading-snug text-muted" title={check.establishes}>“{check.establishes}”</span> : null}
                {check.instances.length ? (
                  <span className="mt-1 flex flex-wrap items-center gap-1" title={t("procedures.graph.node.instancesHint")}>
                    <span className="text-micro text-faint">{t("procedures.graph.node.satisfiedRatio", { satisfied: String(check.instances.filter((instance) => instance.state === "satisfied").length), total: String(check.instances.length) })}</span>
                    {check.instances.map((instance) => (
                      <span
                        key={instance.uri}
                        role="button"
                        tabIndex={0}
                        onClick={(event) => { event.stopPropagation(); data.onSelect?.(`check:${instance.uri}`); }}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); data.onSelect?.(`check:${instance.uri}`); } }}
                        className={cx(
                          "mono inline-flex items-center gap-1 rounded-(--radius-1) border px-1 text-micro leading-4",
                          instance.state === "satisfied" ? "border-success/40 bg-success-soft text-success"
                            : instance.state === "failed" ? "border-danger/40 bg-danger-soft text-danger"
                            : instance.state === "actionable" ? "border-accent/50 bg-accent-soft text-accent"
                            : "border-border bg-surface-2 text-muted",
                        )}
                        title={t("procedures.graph.node.instanceTitle", { value: instance.value, state: t(`procedures.graph.node.liveState.${instance.state ?? "open"}`) })}
                      >
                        {instance.state === "satisfied" ? <CheckCircle2 size={9} /> : instance.state === "failed" ? <XCircle size={9} /> : instance.state === "actionable" ? <Circle size={9} /> : <Lock size={9} />}
                        {instance.value}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </button>
            {check.handles.in ? <Handle id={`in:${check.name}`} type="target" position={Position.Right} style={{ top: "32%" }} className="handle-data handle-in" title={t("procedures.graph.node.consumes")} /> : null}
            {check.handles.out ? <Handle id={`out:${check.name}`} type="source" position={Position.Right} style={{ top: "68%" }} className="handle-data handle-out" title={t("procedures.graph.node.materializes")} /> : null}
          </li>
        ))}
        {data.checks.length === 0 ? <li className="px-3 py-2 text-caption text-faint">{t("procedures.graph.node.noCheck")}</li> : null}
      </ul>
      <Handle id="order-out" type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-border-strong" />
    </div>
  );
}

/* ---------- edges ---------- */

/** Order link between two Scenarios: the target waits for the source to be validated. */
function OrderEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<Edge<OrderEdgeData>>) {
  const { t } = useTranslation();
  const bounds = useRowBounds();
  const tone = data?.emphasis;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (data?.bypassX !== undefined && data.sourceRow?.length && data.targetRow?.length) {
    // Skipping rows: down to the channel under the source row, over to the left lane, down to the channel above the target row, in.
    const below = bounds.bottom(data.sourceRow) + ROW_GAP / 2;
    const above = bounds.top(data.targetRow) - ROW_GAP / 2;
    const points: Array<[number, number]> = [[sourceX, sourceY], [sourceX, below], [data.bypassX, below], [data.bypassX, above], [targetX, above], [targetX, targetY]];
    path = orthogonalPath(points, CORNER);
    labelX = data.bypassX;
    labelY = (below + above) / 2;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: CORNER, offset: 16 });
  }
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} />
      <EdgeLabel x={labelX} y={labelY} tone={tone} kind="order" edge={data}>{data?.done ? t("procedures.graph.edge.validatedDone") : t("procedures.graph.edge.validated")}</EdgeLabel>
    </>
  );
}

/** Data link — orthogonal route from a producing Check to a consuming Check, down a lane on the right,
    labelled with the role that flows. Enters the consumer from the right, arrow pointing at it. */
function DataEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps<Edge<DataEdgeData>>) {
  const bounds = useRowBounds();
  const rowBottom = bounds.bottom;
  const rowTop = bounds.top;
  const laneX = data?.laneX ?? targetX + LANE_START;
  const points: Array<[number, number]> = [[sourceX, sourceY]];
  if (data?.providerGapX != null && data.providerRow.length) {
    // A neighbour sits on the right: leave through the column gap, then the channel below the row.
    const channelY = rowBottom(data.providerRow) + ROW_GAP / 2;
    points.push([data.providerGapX, sourceY], [data.providerGapX, channelY], [laneX, channelY]);
  } else {
    points.push([laneX, sourceY]);
  }
  if (data?.consumerGapX != null && data.consumerRow.length) {
    const channelY = rowTop(data.consumerRow) - ROW_GAP / 2;
    points.push([laneX, channelY], [data.consumerGapX, channelY], [data.consumerGapX, targetY]);
  } else {
    points.push([laneX, targetY]);
  }
  points.push([targetX, targetY]);
  const path = orthogonalPath(points, CORNER);
  // Label on the lane segment, at its planned slot (clamped to the drawn lane).
  const laneStartY = points.find(([x]) => x === laneX)?.[1] ?? sourceY;
  const laneEndY = [...points].reverse().find(([x]) => x === laneX)?.[1] ?? targetY;
  const lo = Math.min(laneStartY, laneEndY) + LABEL_HEIGHT / 2;
  const hi = Math.max(laneStartY, laneEndY) - LABEL_HEIGHT / 2;
  const labelY = Math.min(hi, Math.max(lo, data?.labelY ?? (laneStartY + laneEndY) / 2));
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} />
      {data?.label ? <EdgeLabel x={laneX} y={labelY} tone={data.emphasis} kind="data" edge={data}><RotateCcw size={9} className="mr-0.5 inline-block align-[-1px]" />{data.label}</EdgeLabel> : null}
      <title>{data?.label}</title>
    </>
  );
}

/** Measured top/bottom of a row of cards (ids), for routing through the channels between rows. */
function useRowBounds() {
  const nodeLookup = useStore((state) => state.nodeLookup);
  return {
    bottom: (ids: string[]) => Math.max(...ids.map((nodeId) => { const node = nodeLookup.get(nodeId); return node ? node.internals.positionAbsolute.y + (node.measured.height ?? node.initialHeight ?? HEADER_HEIGHT) : 0; })),
    top: (ids: string[]) => Math.min(...ids.map((nodeId) => nodeLookup.get(nodeId)?.internals.positionAbsolute.y ?? Number.POSITIVE_INFINITY)),
  };
}

/** Polyline with rounded corners (quadratic arcs of the given radius at every turn). */
function orthogonalPath(points: Array<[number, number]>, radius: number): string {
  if (points.length < 2) return "";
  let path = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [px, py] = points[index - 1]!;
    const [cx, cy] = points[index]!;
    const [nx, ny] = points[index + 1]!;
    const inLength = Math.hypot(cx - px, cy - py);
    const outLength = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0.5) { path += ` L ${cx} ${cy}`; continue; }
    const inX = cx - Math.sign(cx - px) * r;
    const inY = cy - Math.sign(cy - py) * r;
    const outX = cx + Math.sign(nx - cx) * r;
    const outY = cy + Math.sign(ny - cy) * r;
    path += ` L ${inX} ${inY} Q ${cx} ${cy} ${outX} ${outY}`;
  }
  const [lx, ly] = points[points.length - 1]!;
  return `${path} L ${lx} ${ly}`;
}

/** Chip on an edge; follows the edge emphasis. Hovering it (or the edge) lights the whole route and unfolds the reading of the link;
    clicking selects the edge. */
function EdgeLabel({ x, y, tone, kind, edge, children }: { x: number; y: number; tone: Emphasis; kind: "order" | "data"; edge: EdgeCommon | undefined; children: ReactNode }) {
  const { t } = useTranslation();
  const lit = edge?.hovered || edge?.focus;
  return (
    <EdgeLabelRenderer>
      <div
        className={cx("absolute", lit ? "z-20" : "z-10", tone === "dim" && !lit && "opacity-20 transition-opacity")}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        <button
          type="button"
          onMouseEnter={() => edge?.onHover?.(edge.id)}
          onMouseLeave={() => edge?.onHover?.(undefined)}
          onClick={(event) => { event.stopPropagation(); edge?.onSelect?.(`edge:${edge.id}`); }}
          className={cx(
            "pointer-events-auto cursor-pointer rounded-(--radius-1) border px-1 py-px text-micro leading-tight",
            kind === "data" && "mono",
            tone === "upstream" ? "border-info/50 bg-info-soft text-info"
              : tone === "downstream" || kind === "data" ? "border-graph-data/60 bg-graph-data-soft text-graph-data"
              : "border-border bg-surface text-muted",
            lit && "ring-2 ring-accent",
          )}
          title={t("procedures.graph.edge.labelHint")}
        >
          {children}
        </button>
        {edge?.hovered && edge.explain ? (
          <div className="pointer-events-none absolute left-1/2 top-full mt-1.5 w-[250px] -translate-x-1/2 rounded-(--radius-2) border border-border bg-surface px-2 py-1.5 text-left font-sans text-meta leading-snug text-text shadow-(--shadow-2)">
            {edge.explain}
          </div>
        ) : null}
      </div>
    </EdgeLabelRenderer>
  );
}

/* ---------- helpers inside the flow ---------- */

/** Bring the selected card into view when it is outside the viewport (selection from the inspector, or return from a link). */
function EnsureVisible({ nodeId }: { nodeId: string | undefined }) {
  const { getInternalNode, fitView, getZoom } = useReactFlow();
  const initialized = useNodesInitialized();
  const domNode = useStore((state) => state.domNode);
  const transform = useStore((state) => state.transform);
  useEffect(() => {
    if (!nodeId || !initialized) return;
    const node = getInternalNode(nodeId);
    const bounds = domNode?.getBoundingClientRect();
    if (!node || !bounds) return;
    const [tx, ty, zoom] = transform;
    const width = (node.measured.width ?? NODE_WIDTH) * zoom;
    const height = (node.measured.height ?? HEADER_HEIGHT) * zoom;
    const left = node.internals.positionAbsolute.x * zoom + tx;
    const top = node.internals.positionAbsolute.y * zoom + ty;
    const visible = left >= 0 && top >= 0 && left + width <= bounds.width && top + height <= bounds.height;
    if (visible) return;
    const current = getZoom();
    void fitView({ nodes: [{ id: nodeId }], duration: 320, minZoom: Math.min(current, 1), maxZoom: Math.min(current, 1), padding: 0.2 });
    // The transform is deliberately read once per selection change: following it would re-centre after every pan.
  }, [nodeId, initialized]);
  return null;
}

/** When the canvas width changes (side panel, inspector), shift the viewport so the diagram stays where the eye left it. */
function KeepCentered() {
  const { getViewport, setViewport } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  useEffect(() => {
    if (!domNode) return;
    let width = domNode.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? width;
      const delta = next - width;
      width = next;
      if (Math.abs(delta) < 1) return;
      const viewport = getViewport();
      void setViewport({ ...viewport, x: viewport.x + delta / 2 });
    });
    observer.observe(domNode);
    return () => observer.disconnect();
  }, [domNode, getViewport, setViewport]);
  return null;
}

function Legend({ selection }: { selection: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-3 rounded-(--radius-2) border border-border bg-surface/95 px-2 py-1 text-meta text-muted shadow-(--shadow-1)">
      <span className="inline-flex items-center gap-1" title={t("procedures.graph.legend.orderHint")}><span className="inline-block h-0 w-4 border-t-2 border-border-strong" />{t("procedures.graph.legend.order")}</span>
      <span className="inline-flex items-center gap-1 text-graph-data" title={t("procedures.graph.legend.dataHint")}><span className="inline-block h-0 w-4 border-t-2 border-dashed border-graph-data" />{t("procedures.graph.legend.data")}</span>
      {selection ? (
        <>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-info" /> {t("procedures.graph.legend.needed")}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-graph-data" /> {t("procedures.graph.legend.resets")}</span>
        </>
      ) : null}
    </div>
  );
}

/* ---------- selection panel ---------- */

function SelectionPanel({ procedure, selected, onSelect }: { procedure: CompiledProcedure; selected: string; onSelect: ProcedureGraphProps["onSelect"] }) {
  const { t } = useTranslation();
  const origin = useOrigin();
  const scenarios = useMemo(() => orderedScenarios(procedure), [procedure]);
  const orderIndex = useMemo(() => {
    const index = new Map<string, number>();
    let position = 0;
    for (const scenario of scenarios) for (const name of scenario.checks) index.set(name, position++);
    return index;
  }, [scenarios]);
  const sortChecks = (names: Iterable<string>) => [...names].sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
  const scenarioTitle = (slug: string) => procedure.scenarios.find((scenario) => scenario.slug === slug)?.title ?? slug;
  const CheckLink = ({ name }: { name: string }) => <CheckButton name={name} onSelect={onSelect} />;

  const scenario = selected.startsWith("scenario:") ? procedure.scenarios.find((entry) => `scenario:${entry.slug}` === selected) : undefined;
  const check = selected.startsWith("check:") ? procedure.checks.find((entry) => `check:${entry.name}` === selected) : undefined;
  const edge = selected.startsWith("edge:") ? findEdge(procedure, selected.slice("edge:".length)) : undefined;
  if (!scenario && !check && !edge) return null;

  const seeds = scenario ? scenario.checks : check ? [check.name] : edge ? (edge.kind === "data" ? [edge.from] : (procedure.scenarios.find((entry) => entry.slug === edge.from)?.checks ?? [])) : [];
  const resets = sortChecks(downstreamOf(procedure, seeds));
  const needs = sortChecks(upstreamOf(procedure, seeds));

  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-border bg-surface">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <span className="kicker">{check ? t("procedures.graph.panel.check") : scenario ? t("procedures.graph.panel.scenario") : edge?.kind === "data" ? t("procedures.graph.panel.dataLink") : t("procedures.graph.panel.orderLink")}</span>
          {edge ? (
            <strong className="block text-ui leading-snug">
              {edge.kind === "data" ? <><Str>{edge.from}</Str> <span className="text-graph-data">↓ ↺ {edge.link.role ?? edge.link.field}</span> <Str>{edge.to}</Str></> : <><Str>{scenarioTitle(edge.from)}</Str> <span className="text-muted">{t("procedures.graph.panel.validatedArrow")}</span> <Str>{scenarioTitle(edge.to)}</Str></>}
            </strong>
          ) : (
            <strong className="mono block truncate text-ui" title={check?.name ?? scenario?.title}>{check?.name ?? scenario?.title}</strong>
          )}
          {check ? <span className="block truncate text-caption text-muted">{t("procedures.graph.panel.inScenario", { title: scenarioTitle(check.scenario) })}</span> : null}
        </div>
        <IconButton size="sm" label={t("procedures.graph.panel.clearSelection")} onClick={() => onSelect?.(undefined)}><X size={14} /></IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-body [&>*]:shrink-0">
        {check ? <CheckDetails procedure={procedure} check={check} origin={origin} CheckLink={CheckLink} /> : null}
        {edge ? (
          <PanelSection title={t("procedures.graph.panel.reading")}>
            <p className="text-label leading-snug">
              {edge.kind === "data"
                ? readDataEdge(edge.link, downstreamOf(procedure, [edge.from]).size - 1)
                : readOrderEdge(scenarioTitle(edge.from), scenarioTitle(edge.to), downstreamOf(procedure, procedure.scenarios.find((entry) => entry.slug === edge.from)?.checks ?? []).size)}
            </p>
            <p className="mt-1 text-caption text-muted">{t("procedures.graph.panel.arrowExplain")}</p>
            <p className="mt-1 text-caption">
              {edge.kind === "data" ? <>{t("procedures.graph.panel.goTo")} <CheckLink name={edge.from} /> · <CheckLink name={edge.to} /></> : null}
            </p>
          </PanelSection>
        ) : null}
        {scenario ? (
          <PanelSection title={t("procedures.graph.panel.checks")} count={scenario.checks.length}>
            <ul className="flex flex-col gap-0.5">{scenario.checks.map((name) => <li key={name}><CheckLink name={name} /></li>)}</ul>
            {scenario.dependencies.length ? <p className="mt-1 text-caption text-muted">{t("procedures.graph.panel.after", { list: scenario.dependencies.map(scenarioTitle).join(", ") })}</p> : null}
          </PanelSection>
        ) : null}
        <PanelSection title={t("procedures.graph.panel.needs")} count={needs.length} icon={<ArrowUpFromLine size={11} className="text-info" />} hint={t("procedures.graph.panel.needsHint")}>
          {needs.length === 0 ? <p className="text-caption text-muted">{t("procedures.graph.panel.needsNothing")}</p> : <ul className="flex flex-col gap-0.5">{needs.map((name) => <li key={name}><CheckLink name={name} /></li>)}</ul>}
        </PanelSection>
        <PanelSection title={t("procedures.graph.panel.resets")} count={resets.length} icon={<RotateCcw size={11} className="text-graph-data" />} hint={t("procedures.graph.panel.resetsHint", { subject: check ? t("procedures.graph.panel.subjectThisCheck") : edge ? (edge.kind === "data" ? t("procedures.graph.panel.subjectQuoted", { name: edge.from }) : t("procedures.graph.panel.subjectAnyCheckOf", { title: scenarioTitle(edge.from) })) : t("procedures.graph.panel.subjectAnyCheckOfThisScenario") })}>
          {resets.length === 0 ? <p className="text-caption text-muted">{t("procedures.graph.panel.resetsNothing")}</p> : (
            <ul className="flex flex-col gap-0.5">
              {resets.map((name) => (
                <li key={name} className="flex items-baseline justify-between gap-2">
                  <CheckLink name={name} />
                  <span className="truncate text-meta text-faint">{scenarioTitle(procedure.checks.find((entry) => entry.name === name)?.scenario ?? "")}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      </div>
    </aside>
  );
}

function CheckDetails({ procedure, check, origin, CheckLink }: { procedure: CompiledProcedure; check: ProcedureCheck; origin: ReturnType<typeof useOrigin>; CheckLink: (props: { name: string }) => ReactNode }) {
  const { t } = useTranslation();
  const providers = providersOf(procedure, check.name);
  const consumers = consumersOf(procedure, check.name);
  const prerequisites = orderPrerequisites(procedure, check);
  return (
    <>
      <PanelSection title={t("procedures.graph.panel.runs")}>
        <Link to={`/operations/${encodeURIComponent(check.operation)}`} state={origin} className="mono inline-flex items-center gap-1 text-body text-accent hover:underline">
          <TerminalSquare size={12} /> {check.operation}{check.operationVersion ? <span className="text-faint">@{check.operationVersion}</span> : null}
        </Link>
        {check.target ? <p className="mt-0.5 text-label text-muted">{check.target.selection === "each" ? t("procedures.graph.node.onEach") : t("procedures.graph.node.on")} <span className="mono text-text">{check.target.role}</span> <span className="text-faint">· {describeProvenance(roleProvenance(procedure, check.target.role))}</span></p> : null}
        {check.successReason ? <p className="mt-1 text-label text-muted">{t("procedures.graph.panel.mustEstablish", { reason: check.successReason })}</p> : null}
      </PanelSection>
      {check.inputBindings?.length ? (
        <PanelSection title={t("procedures.graph.panel.inputs")} count={check.inputBindings.length}>
          <ul className="flex flex-col gap-1">
            {check.inputBindings.map((binding) => {
              const provenance = roleProvenance(procedure, binding.role);
              return (
                <li key={binding.input} className="leading-snug">
                  <span className="mono">{binding.input}</span> <span className="text-faint">←</span> <span className="mono">{binding.role}</span>
                  <span className="block text-meta text-muted">
                    {provenance?.kind === "operation-field" && provenance.check ? <>{t("procedures.graph.panel.fromCheck")} <CheckLink name={provenance.check} /> · {provenance.field}</> : describeProvenance(provenance)}
                  </span>
                </li>
              );
            })}
          </ul>
        </PanelSection>
      ) : null}
      {check.materializes?.length ? (
        <PanelSection title={t("procedures.graph.panel.materializes")} count={check.materializes.length} icon={<ArrowDownToLine size={11} className="text-muted" />}>
          <ul className="flex flex-col gap-1">
            {check.materializes.map((entry) => {
              const used = consumers.filter((link) => link.role === entry.role);
              return (
                <li key={entry.role} className="leading-snug">
                  <span className="mono">{entry.role}</span> <span className="text-faint">{t("procedures.graph.panel.fromField")}</span> <span className="mono">{entry.field}</span>
                  <span className="block text-meta text-muted">
                    {used.length ? <>{t("procedures.graph.panel.usedBy")} {used.map((link, index) => <span key={link.to}>{index ? ", " : ""}<CheckLink name={link.to} /></span>)}</> : t("procedures.graph.panel.notConsumed")}
                  </span>
                </li>
              );
            })}
          </ul>
        </PanelSection>
      ) : null}
      {providers.length || prerequisites.length ? (
        <PanelSection title={t("procedures.graph.panel.directDependencies")}>
          <ul className="flex flex-col gap-1">
            {providers.map((link) => (
              <li key={`${link.from}:${link.role ?? link.field}`} className="leading-snug text-label">
                <span className="text-muted">{t("procedures.graph.panel.data")}</span> <span className="mono">{link.role ?? link.field}</span> <span className="text-muted">{t("procedures.graph.panel.from")}</span> <CheckLink name={link.from} />
              </li>
            ))}
            {prerequisites.map((prerequisite) => (
              <li key={prerequisite.scenario} className="leading-snug text-label">
                <span className="text-muted">{t("procedures.graph.panel.order")}</span> {t("procedures.graph.panel.scenarioValidated", { title: prerequisite.title })}{prerequisite.checks.length ? <> ({plural(prerequisite.checks.length, "check")})</> : null}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}
    </>
  );
}

function CheckButton({ name, onSelect }: { name: string; onSelect: ProcedureGraphProps["onSelect"] }) {
  return (
    <button type="button" onClick={() => onSelect?.(`check:${name}`)} className="mono rounded-(--radius-1) px-1 text-left text-label text-text hover:bg-surface-2 hover:underline">{name}</button>
  );
}

function PanelSection({ title, count, icon, hint, children }: { title: string; count?: number; icon?: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-1.5">
        {icon}
        <span className="kicker">{title}</span>
        {count !== undefined ? <span className="text-meta text-faint">{count}</span> : null}
      </div>
      {hint ? <p className="mb-1 text-meta leading-snug text-faint">{hint}</p> : null}
      {children}
    </section>
  );
}

function scenarioLevels(procedure: CompiledProcedure): Map<string, number> {
  const result = new Map<string, number>();
  const visit = (slug: string, trail = new Set<string>()): number => {
    if (result.has(slug)) return result.get(slug)!;
    if (trail.has(slug)) return 0;
    const scenario = procedure.scenarios.find((candidate) => candidate.slug === slug);
    if (!scenario || scenario.dependencies.length === 0) return 0;
    const nextTrail = new Set(trail).add(slug);
    const level = 1 + Math.max(...scenario.dependencies.map((dependency) => visit(dependency, nextTrail)));
    result.set(slug, level);
    return level;
  };
  procedure.scenarios.forEach((scenario) => result.set(scenario.slug, visit(scenario.slug)));
  return result;
}
