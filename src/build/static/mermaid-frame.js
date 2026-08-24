(() => {
  'use strict';

  const MAX_SOURCE_LENGTH = 100000;
  const MAX_SVG_LENGTH = 5000000;
  let renderSequence = 0;
  let connected = false;

  const safeSvg = (svg) => {
    if (typeof svg !== 'string' || svg.length > MAX_SVG_LENGTH || !/^\s*<svg\b/i.test(svg)) return false;
    return !/<(?:script|iframe|object|embed)\b/i.test(svg)
      && !/\son[a-z]+\s*=/i.test(svg)
      && !/(?:href|src)\s*=\s*["']\s*javascript:/i.test(svg);
  };

  const handleRender = async (port, message) => {
    if (message.type !== 'render' || typeof message.requestId !== 'string') return;
    if (typeof message.source !== 'string' || !message.source.trim() || message.source.length > MAX_SOURCE_LENGTH) {
      port.postMessage({ type: 'result', requestId: message.requestId, ok: false, error: 'Invalid Mermaid source.' });
      return;
    }

    try {
      const id = `kiwi-mermaid-frame-${++renderSequence}`;
      const result = await window.mermaid.render(id, message.source);
      if (!result || !safeSvg(result.svg)) throw new Error('Mermaid produced unsafe SVG output.');
      port.postMessage({ type: 'result', requestId: message.requestId, ok: true, svg: result.svg });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Mermaid rendering failed.';
      port.postMessage({ type: 'result', requestId: message.requestId, ok: false, error: detail.slice(0, 500) });
    }
  };

  if (!window.mermaid || window.parent === window) return;
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });

  window.addEventListener('message', (event) => {
    if (connected || event.source !== window.parent || event.data?.type !== 'kiwi-mermaid-connect') return;
    const port = event.ports && event.ports[0];
    if (!port) return;
    connected = true;
    port.addEventListener('message', messageEvent => handleRender(port, messageEvent.data || {}));
    port.start();
    port.postMessage({ type: 'ready' });
  });
})();
