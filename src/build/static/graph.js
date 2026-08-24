// Accessible D3 force-directed knowledge graph.
document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("graph-container");
    const status = document.getElementById("graph-status");
    if (!container) return;

    const setStatus = (message) => {
        if (status) status.textContent = message;
    };

    try {
        if (typeof d3 === "undefined") throw new Error("D3 unavailable");
        const response = await fetch("/graph-data.json", { credentials: "same-origin" });
        if (!response.ok) throw new Error("graph data " + response.status);
        const data = await response.json();
        if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) throw new Error("invalid graph data");

        if (!data.nodes.length) {
            setStatus("문서를 추가하면 지식 그래프가 표시됩니다.");
            container.setAttribute("aria-busy", "false");
            return;
        }

        const styles = getComputedStyle(document.documentElement);
        const cssColor = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
        const colors = {
            source: "#1976d2",
            sourceHover: "#0d47a1",
            concept: cssColor("--namu-green", "#008f83"),
            conceptHover: cssColor("--namu-green-dark", "#006b62"),
            link: cssColor("--graph-link", "#a9b0b7"),
            text: cssColor("--text", "#212529"),
            nodeStroke: cssColor("--bg", "#ffffff"),
            focus: cssColor("--focus-ring", "#ffbf47"),
        };

        const width = Math.max(container.clientWidth, 320);
        const height = Math.max(container.clientHeight, 420);
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        setStatus("");

        const svg = d3.select(container)
            .append("svg")
            .attr("viewBox", [0, 0, width, height])
            .attr("role", "group")
            .attr("aria-describedby", "graph-keyboard-help")
            .attr("aria-label", `${data.nodes.length}개 문서와 ${data.links.length}개 연결로 구성된 지식 그래프`);
        svg.append("title").text("지식 그래프");
        svg.append("desc")
            .attr("id", "graph-keyboard-help")
            .text("Tab 키로 그래프에 들어간 뒤 방향키로 문서를 탐색합니다. Home과 End 키로 처음과 끝 문서로 이동하고 Enter 또는 Space 키로 엽니다.");

        const g = svg.append("g");
        const zoom = d3.zoom()
            .filter((event) => {
                const target = event.target;
                const isNodeGesture = event.type !== "wheel"
                    && target instanceof Element
                    && Boolean(target.closest(".graph-node"));
                return !isNodeGesture && (!event.ctrlKey || event.type === "wheel") && !event.button;
            })
            .scaleExtent([0.3, 4])
            .on("zoom", (event) => g.attr("transform", event.transform));

        // d3.zoom installs its tap-highlight reset through the selection style API,
        // which violates style-src-attr 'none'. External CSS owns that style;
        // suppress only D3's two known behavior defaults during synchronous
        // behavior installation, and restore the shared prototype immediately.
        function callBehaviorWithoutInlineStyles(selection, behavior) {
            const methodName = "style";
            const selectionPrototype = d3.selection.prototype;
            const originalStyle = selectionPrototype[methodName];
            if (typeof originalStyle !== "function") throw new Error("D3 selection style adapter unavailable");
            selectionPrototype[methodName] = function (name) {
                if (name === "touch-action" || name === "-webkit-tap-highlight-color") return this;
                throw new Error(`Unexpected D3 inline style request: ${String(name)}`);
            };
            try {
                selection.call(behavior);
            } finally {
                selectionPrototype[methodName] = originalStyle;
            }
        }
        callBehaviorWithoutInlineStyles(svg, zoom);

        const simulation = d3.forceSimulation(data.nodes)
            .force("link", d3.forceLink(data.links).id((node) => node.id).distance(100))
            .force("charge", d3.forceManyBody().strength(-300))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("collision", d3.forceCollide().radius(34));

        const link = g.append("g")
            .attr("aria-hidden", "true")
            .selectAll("line")
            .data(data.links)
            .join("line")
            .attr("stroke", colors.link)
            .attr("stroke-width", 1.5)
            .attr("stroke-opacity", 0.72);

        const node = g.append("g")
            .attr("role", "group")
            .attr("aria-label", "문서 노드")
            .selectAll("g")
            .data(data.nodes)
            .join("g")
            .attr("class", "graph-node")
            .attr("role", "link")
            .attr("tabindex", (_item, index) => index === 0 ? 0 : -1)
            .attr("aria-label", (item) => `${item.title}, ${item.type === "source" ? "원본 문서" : "개념 문서"}, 연결 ${item.degree || 0}개`);

        node.append("circle")
            .attr("r", (item) => Math.max(7, Math.min(20, 4 + (item.degree || 0) * 2)))
            .attr("fill", (item) => item.type === "source" ? colors.source : colors.concept)
            .attr("stroke", colors.nodeStroke)
            .attr("stroke-width", 2);

        node.append("text")
            .text((item) => item.title)
            .attr("dx", (item) => Math.max(8, 6 + (item.degree || 0) * 2) + 4)
            .attr("dy", 4)
            .attr("font-size", "12px")
            .attr("fill", colors.text)
            .attr("aria-hidden", "true");

        function openNode(item) {
            window.location.href = `/wiki/${encodeURIComponent(item.id)}.html`;
        }

        const nodeKey = (item) => String(item.id);
        let activeNodeKey = nodeKey(data.nodes[0]);

        function nodeEntries() {
            return node.nodes().map((element, index) => ({
                element,
                index,
                item: element.__data__,
            }));
        }

        function updateRovingTabstop(key, focus) {
            const entries = nodeEntries();
            const target = entries.find((entry) => nodeKey(entry.item) === key) || entries[0];
            if (!target) return;
            activeNodeKey = nodeKey(target.item);
            node.attr("tabindex", (item) => nodeKey(item) === activeNodeKey ? 0 : -1);
            if (focus) target.element.focus({ preventScroll: true });
        }

        function directionalTarget(currentItem, key) {
            const entries = nodeEntries();
            const currentIndex = entries.findIndex((entry) => nodeKey(entry.item) === nodeKey(currentItem));
            if (currentIndex < 0 || entries.length < 2) return null;
            if (key === "Home") return entries[0];
            if (key === "End") return entries[entries.length - 1];

            const currentX = Number(currentItem.x);
            const currentY = Number(currentItem.y);
            const horizontal = key === "ArrowLeft" || key === "ArrowRight";
            const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
            if (Number.isFinite(currentX) && Number.isFinite(currentY)) {
                const candidates = entries
                    .filter((entry) => entry.index !== currentIndex)
                    .map((entry) => {
                        const dx = Number(entry.item.x) - currentX;
                        const dy = Number(entry.item.y) - currentY;
                        const primary = horizontal ? dx : dy;
                        const secondary = horizontal ? dy : dx;
                        if (!Number.isFinite(dx) || !Number.isFinite(dy) || primary * direction <= 0) return null;
                        return {
                            ...entry,
                            // Prefer nearby nodes in the requested half-plane while
                            // mildly penalising movement away from the arrow axis.
                            score: Math.hypot(dx, dy) + Math.abs(secondary) * 0.35,
                        };
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.score - b.score || a.index - b.index);
                if (candidates.length) return candidates[0];
            }

            // A newly-started simulation can briefly lack usable coordinates.
            // Fall back to deterministic list order, wrapping at the ends.
            const offset = direction < 0 ? -1 : 1;
            return entries[(currentIndex + offset + entries.length) % entries.length];
        }

        function emphasize(element, item, active) {
            const baseColor = item.type === "source" ? colors.source : colors.concept;
            const hoverColor = item.type === "source" ? colors.sourceHover : colors.conceptHover;
            d3.select(element).select("circle")
                .attr("fill", active ? hoverColor : baseColor)
                .attr("stroke", active ? colors.focus : colors.nodeStroke)
                .attr("stroke-width", active ? 3 : 2);
            link.attr("stroke", (edge) => active && (edge.source.id === item.id || edge.target.id === item.id) ? baseColor : colors.link)
                .attr("stroke-width", (edge) => active && (edge.source.id === item.id || edge.target.id === item.id) ? 2.5 : 1.5);
        }

        const pointerDrags = new WeakMap();
        const suppressedClicks = new WeakSet();
        node.on("pointerdown.drag", function (event, item) {
            if (!event.isPrimary || event.button !== 0 || pointerDrags.has(this)) return;
            const [x, y] = d3.pointer(event, g.node());
            pointerDrags.set(this, {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
            });
            this.setPointerCapture?.(event.pointerId);
            if (!reduceMotion) simulation.alphaTarget(0.3).restart();
            item.fx = x;
            item.fy = y;
            event.preventDefault();
            event.stopPropagation();
        });
        node.on("pointermove.drag", function (event, item) {
            const state = pointerDrags.get(this);
            if (!state || state.pointerId !== event.pointerId) return;
            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if ((dx * dx) + (dy * dy) > 16) state.moved = true;
            const [x, y] = d3.pointer(event, g.node());
            item.fx = x;
            item.fy = y;
            if (reduceMotion) {
                item.x = x;
                item.y = y;
                renderPositions();
            }
            event.preventDefault();
            event.stopPropagation();
        });

        function finishPointerDrag(element, event, item) {
            const state = pointerDrags.get(element);
            if (!state || state.pointerId !== event.pointerId) return;
            pointerDrags.delete(element);
            if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
            simulation.alphaTarget(0);
            item.fx = null;
            item.fy = null;
            if (state.moved) {
                suppressedClicks.add(element);
                setTimeout(() => suppressedClicks.delete(element), 0);
            }
            event.preventDefault();
            event.stopPropagation();
        }

        node.on("pointerup.drag pointercancel.drag", function (event, item) {
            finishPointerDrag(this, event, item);
        });
        node.on("click", function (event, item) {
            if (suppressedClicks.has(this)) {
                suppressedClicks.delete(this);
                event.preventDefault();
                return;
            }
            openNode(item);
        });
        node.on("keydown", (event, item) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openNode(item);
                return;
            }
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            const target = directionalTarget(item, event.key);
            if (!target) return;
            event.preventDefault();
            updateRovingTabstop(nodeKey(target.item), true);
        });
        node.on("focus.roving", function (_event, item) {
            updateRovingTabstop(nodeKey(item), false);
        });
        node.on("mouseenter.emphasis focus.emphasis", function (_event, item) { emphasize(this, item, true); });
        node.on("mouseleave.emphasis blur.emphasis", function (_event, item) { emphasize(this, item, false); });

        function renderPositions() {
            link
                .attr("x1", (edge) => edge.source.x)
                .attr("y1", (edge) => edge.source.y)
                .attr("x2", (edge) => edge.target.x)
                .attr("y2", (edge) => edge.target.y);
            // Keep the existing node elements: force ticks may repaint positions,
            // but must not replace the focused element or reset its roving tabstop.
            node.attr("transform", (item) => `translate(${item.x},${item.y})`);
        }
        simulation.on("tick", renderPositions);
        if (reduceMotion) {
            simulation.stop();
            const iterations = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
            simulation.tick(iterations);
            renderPositions();
        }

        function zoomBy(factor) {
            svg.transition().duration(reduceMotion ? 0 : 180).call(zoom.scaleBy, factor);
        }
        document.getElementById("graph-zoom-in")?.addEventListener("click", () => zoomBy(1.25));
        document.getElementById("graph-zoom-out")?.addEventListener("click", () => zoomBy(0.8));
        document.getElementById("graph-reset")?.addEventListener("click", () => {
            svg.transition().duration(reduceMotion ? 0 : 180).call(zoom.transform, d3.zoomIdentity);
        });

        container.setAttribute("aria-busy", "false");
    } catch {
        setStatus("그래프를 불러오지 못했습니다. 페이지를 새로고침해 다시 시도해 주세요.");
        container.classList.add("has-error");
        container.setAttribute("aria-busy", "false");
    }
});
