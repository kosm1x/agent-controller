/**
 * Goal graph SVG renderer.
 * Draws Prometheus goal graphs as layered DAGs.
 */

const STATUS_COLORS = {
  pending: "#6b7280",
  in_progress: "#3b82f6",
  completed: "#22c55e",
  blocked: "#f59e0b",
  failed: "#ef4444",
};

const NODE_W = 170;
const NODE_H = 56;
const LAYER_GAP = 100;
const NODE_GAP = 30;

export function renderGoalGraph(container, goalGraphJSON) {
  container.innerHTML = "";

  let graph;
  try {
    graph =
      typeof goalGraphJSON === "string"
        ? JSON.parse(goalGraphJSON)
        : goalGraphJSON;
  } catch {
    container.textContent = "Invalid goal graph data";
    return;
  }

  const goals = graph?.goals;
  if (!goals || typeof goals !== "object") {
    container.textContent = "No goals in graph";
    return;
  }

  const ids = Object.keys(goals);
  if (ids.length === 0) {
    container.textContent = "Empty goal graph";
    return;
  }

  // Build adjacency (deps → dependents)
  const depMap = new Map();
  for (const id of ids) {
    depMap.set(id, goals[id].depends_on || []);
  }

  // Topological sort + layer assignment (longest path from roots)
  const layers = new Map();
  const visited = new Set();

  function assignLayer(id) {
    if (visited.has(id)) return layers.get(id) || 0;
    visited.add(id);
    const deps = depMap.get(id) || [];
    let maxDepLayer = -1;
    for (const dep of deps) {
      if (ids.includes(dep)) {
        maxDepLayer = Math.max(maxDepLayer, assignLayer(dep));
      }
    }
    const layer = maxDepLayer + 1;
    layers.set(id, layer);
    return layer;
  }

  for (const id of ids) assignLayer(id);

  // Group by layer
  const layerGroups = new Map();
  for (const [id, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer).push(id);
  }

  const maxLayer = Math.max(...layerGroups.keys());
  const maxNodesInLayer = Math.max(
    ...[...layerGroups.values()].map((g) => g.length),
  );

  // Position nodes
  const positions = new Map();
  for (const [layer, nodeIds] of layerGroups) {
    const totalWidth =
      nodeIds.length * NODE_W + (nodeIds.length - 1) * NODE_GAP;
    const startX =
      (maxNodesInLayer * (NODE_W + NODE_GAP) - NODE_GAP - totalWidth) / 2;
    nodeIds.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * (NODE_W + NODE_GAP),
        y: layer * (NODE_H + LAYER_GAP),
      });
    });
  }

  const svgWidth = maxNodesInLayer * (NODE_W + NODE_GAP) - NODE_GAP + 40;
  const svgHeight = (maxLayer + 1) * (NODE_H + LAYER_GAP) - LAYER_GAP + 40;

  // Build SVG
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
  svg.setAttribute("width", "100%");
  svg.style.maxHeight = "400px";

  // Arrow marker
  const defs = document.createElementNS(ns, "defs");
  const marker = document.createElementNS(ns, "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const arrowPath = document.createElementNS(ns, "path");
  arrowPath.setAttribute("d", "M0,0 L8,3 L0,6 Z");
  arrowPath.setAttribute("fill", "#4b5563");
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Draw edges
  for (const id of ids) {
    const deps = depMap.get(id) || [];
    const to = positions.get(id);
    for (const dep of deps) {
      const from = positions.get(dep);
      if (!from || !to) continue;

      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(from.x + NODE_W / 2 + 20));
      line.setAttribute("y1", String(from.y + NODE_H + 20));
      line.setAttribute("x2", String(to.x + NODE_W / 2 + 20));
      line.setAttribute("y2", String(to.y + 20));
      line.setAttribute("stroke", "#4b5563");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("marker-end", "url(#arrowhead)");
      svg.appendChild(line);
    }
  }

  // Draw nodes
  for (const id of ids) {
    const pos = positions.get(id);
    const goal = goals[id];
    const color = STATUS_COLORS[goal.status] || STATUS_COLORS.pending;

    const g = document.createElementNS(ns, "g");
    g.setAttribute("transform", `translate(${pos.x + 20}, ${pos.y + 20})`);

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("width", String(NODE_W));
    rect.setAttribute("height", String(NODE_H));
    rect.setAttribute("rx", "8");
    rect.setAttribute("fill", "#1e293b");
    rect.setAttribute("stroke", color);
    rect.setAttribute("stroke-width", "2");
    if (goal.status === "in_progress") {
      rect.style.animation = "pulse 2s infinite";
    }
    g.appendChild(rect);

    // Goal ID
    const idText = document.createElementNS(ns, "text");
    idText.setAttribute("x", "10");
    idText.setAttribute("y", "18");
    idText.setAttribute("fill", "#9ca3af");
    idText.setAttribute("font-size", "10");
    idText.textContent = id;
    g.appendChild(idText);

    // Description
    const descText = document.createElementNS(ns, "text");
    descText.setAttribute("x", "10");
    descText.setAttribute("y", "38");
    descText.setAttribute("fill", "#e2e8f0");
    descText.setAttribute("font-size", "12");
    const desc = goal.description || "";
    descText.textContent = desc.length > 22 ? desc.slice(0, 20) + "..." : desc;
    g.appendChild(descText);

    // Tooltip
    const title = document.createElementNS(ns, "title");
    title.textContent = `${id}: ${goal.description || "—"}\nStatus: ${goal.status}`;
    g.appendChild(title);

    svg.appendChild(g);
  }

  container.appendChild(svg);
}
