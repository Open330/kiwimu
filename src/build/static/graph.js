// Knowledge graph visualization using D3.js force-directed layout
document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("graph-container");
    if (!container) return;

    const resp = await fetch("/graph-data.json");
    const data = await resp.json();

    if (!data.nodes.length) {
        container.innerHTML = '<p style="padding:40px;color:#6c757d;">문서를 추가하면 지식 그래프가 표시됩니다.</p>';
        return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;

    const svg = d3.select(container)
        .append("svg")
        .attr("viewBox", [0, 0, width, height]);

    // Zoom
    const g = svg.append("g");
    svg.call(d3.zoom()
        .scaleExtent([0.3, 4])
        .on("zoom", (event) => g.attr("transform", event.transform)));

    const simulation = d3.forceSimulation(data.nodes)
        .force("link", d3.forceLink(data.links).id(d => d.id).distance(100))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collision", d3.forceCollide().radius(30));

    // Links
    const link = g.append("g")
        .selectAll("line")
        .data(data.links)
        .join("line")
        .attr("stroke", "#dee2e6")
        .attr("stroke-width", 1.5)
        .attr("stroke-opacity", 0.6);

    // Nodes
    const node = g.append("g")
        .selectAll("g")
        .data(data.nodes)
        .join("g")
        .style("cursor", "pointer")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    node.append("circle")
        .attr("r", d => Math.max(6, Math.min(20, 4 + d.degree * 2)))
        .attr("fill", "#4caf50")
        .attr("stroke", "#fff")
        .attr("stroke-width", 2);

    node.append("text")
        .text(d => d.title)
        .attr("dx", d => Math.max(8, 6 + d.degree * 2) + 4)
        .attr("dy", 4)
        .attr("font-size", "12px")
        .attr("fill", "#212529");

    // Click to navigate
    node.on("click", (event, d) => {
        window.location.href = `/wiki/${d.id}.html`;
    });

    // Hover highlight
    node.on("mouseenter", function(event, d) {
        d3.select(this).select("circle").attr("fill", "#2e7d32");
        link.attr("stroke", l =>
            l.source.id === d.id || l.target.id === d.id ? "#4caf50" : "#dee2e6"
        ).attr("stroke-width", l =>
            l.source.id === d.id || l.target.id === d.id ? 2.5 : 1.5
        );
    }).on("mouseleave", function() {
        d3.select(this).select("circle").attr("fill", "#4caf50");
        link.attr("stroke", "#dee2e6").attr("stroke-width", 1.5);
    });

    simulation.on("tick", () => {
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
    }

    function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
    }

    function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
    }
});
