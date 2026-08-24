(() => {
  const MATH_SKIP_SELECTOR = 'script, style, textarea, pre, code, math, .katex, .mermaid';

  const isEscaped = (text, index) => {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
    return slashCount % 2 === 1;
  };

  const findMathEnd = (text, delimiter, start) => {
    let braceDepth = 0;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      if (text[cursor] === '\\') {
        cursor += 1;
        continue;
      }
      if (text[cursor] === '{') {
        braceDepth += 1;
        continue;
      }
      if (text[cursor] === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (braceDepth === 0 && text.startsWith(delimiter, cursor) && !isEscaped(text, cursor)) {
        // Inline TeX delimiters may not have whitespace immediately inside the
        // closing edge. This prevents ordinary prices such as "$5 and $10"
        // from being interpreted as a formula while leaving display math alone.
        if (delimiter === '$' && /\s/.test(text[cursor - 1] || '')) continue;
        return cursor;
      }
    }
    return -1;
  };

  const splitMath = (text) => {
    const segments = [];
    let cursor = 0;
    let plainStart = 0;

    while (cursor < text.length) {
      if (text[cursor] !== '$' || isEscaped(text, cursor)) {
        cursor += 1;
        continue;
      }

      const display = text[cursor + 1] === '$';
      const delimiter = display ? '$$' : '$';
      const sourceStart = cursor + delimiter.length;
      if (!display && /\s/.test(text[sourceStart] || '')) {
        cursor += delimiter.length;
        continue;
      }
      const end = findMathEnd(text, delimiter, sourceStart);
      if (end < 0 || end === sourceStart) {
        cursor += delimiter.length;
        continue;
      }

      if (cursor > plainStart) segments.push({ type: 'text', value: text.slice(plainStart, cursor) });
      segments.push({
        type: 'math',
        value: text.slice(sourceStart, end),
        display,
        literal: text.slice(cursor, end + delimiter.length),
      });
      cursor = end + delimiter.length;
      plainStart = cursor;
    }

    if (plainStart < text.length) segments.push({ type: 'text', value: text.slice(plainStart) });
    return segments;
  };

  const mathElement = (source, display) => {
    const markup = window.katex.renderToString(source, {
      displayMode: display,
      output: 'mathml',
      throwOnError: true,
      trust: false,
      strict: 'warn',
      maxSize: 20,
      maxExpand: 1000,
    });
    if (/<(?:script|style|iframe|object|embed)\b/i.test(markup) || /\s(?:style|on[a-z]+)\s*=/i.test(markup)) {
      throw new Error('KaTeX returned CSP-incompatible markup.');
    }

    const template = document.createElement('template');
    template.innerHTML = markup;
    const element = template.content.firstElementChild;
    if (!element || template.content.children.length !== 1 || element.tagName.toLowerCase() !== 'span') {
      throw new Error('KaTeX returned unexpected markup.');
    }
    if (template.content.querySelector('script, style, iframe, object, embed, [style]')) {
      throw new Error('KaTeX returned active or inline-styled markup.');
    }
    for (const descendant of template.content.querySelectorAll('*')) {
      for (const attribute of descendant.attributes) {
        if (/^on/i.test(attribute.name) || (/^(?:href|src)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value))) {
          throw new Error('KaTeX returned executable markup.');
        }
      }
    }

    element.classList.remove('katex');
    element.classList.add('kiwi-math');
    if (display) element.classList.add('kiwi-math-display');
    return element;
  };

  window.kiwiRenderMath = (root) => {
    if (!window.katex || typeof window.katex.renderToString !== 'function') return;
    const scope = root && root.nodeType ? root : document.body;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue?.includes('$') && !node.parentElement?.closest(MATH_SKIP_SELECTOR)) textNodes.push(node);
    }

    for (const node of textNodes) {
      const segments = splitMath(node.nodeValue || '');
      if (!segments.some((segment) => segment.type === 'math')) continue;
      const fragment = document.createDocumentFragment();
      for (const segment of segments) {
        if (segment.type === 'text') {
          fragment.appendChild(document.createTextNode(segment.value));
          continue;
        }
        try {
          fragment.appendChild(mathElement(segment.value, segment.display));
        } catch {
          fragment.appendChild(document.createTextNode(segment.literal));
        }
      }
      node.replaceWith(fragment);
    }
  };

  const MERMAID_FRAME_URL = '/kiwimu/static/mermaid-frame.htm';
  const MERMAID_CONNECT_TIMEOUT_MS = 10000;
  const MERMAID_RENDER_TIMEOUT_MS = 15000;
  let mermaidRendererPromise = null;
  let mermaidRequestId = 0;

  // Mermaid needs runtime-generated <style> blocks and style attributes. Keep
  // that exception out of the application document by rendering inside a
  // sandboxed, opaque-origin frame. Only inert SVG image bytes cross back over
  // a private MessagePort; the frame never receives same-origin DOM access.
  const loadMermaidRenderer = () => {
    if (mermaidRendererPromise) return mermaidRendererPromise;

    mermaidRendererPromise = new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const channel = new MessageChannel();
      const pending = new Map();
      let connected = false;

      frame.className = 'mermaid-render-frame';
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = MERMAID_FRAME_URL;

      const connectTimer = setTimeout(() => {
        if (connected) return;
        channel.port1.close();
        frame.remove();
        reject(new Error('Mermaid renderer did not become ready.'));
      }, MERMAID_CONNECT_TIMEOUT_MS);

      channel.port1.addEventListener('message', (event) => {
        const message = event.data || {};
        if (message.type === 'ready') {
          connected = true;
          clearTimeout(connectTimer);
          resolve({
            render(source) {
              return new Promise((resolveRender, rejectRender) => {
                const requestId = String(++mermaidRequestId);
                const timer = setTimeout(() => {
                  pending.delete(requestId);
                  rejectRender(new Error('Mermaid rendering timed out.'));
                }, MERMAID_RENDER_TIMEOUT_MS);
                pending.set(requestId, { resolve: resolveRender, reject: rejectRender, timer });
                channel.port1.postMessage({ type: 'render', requestId, source });
              });
            },
          });
          return;
        }

        if (message.type !== 'result' || typeof message.requestId !== 'string') return;
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.ok && typeof message.svg === 'string') request.resolve(message.svg);
        else request.reject(new Error(typeof message.error === 'string' ? message.error : 'Mermaid rendering failed.'));
      });
      channel.port1.start();

      frame.addEventListener('load', () => {
        if (!frame.contentWindow) {
          clearTimeout(connectTimer);
          reject(new Error('Mermaid renderer frame is unavailable.'));
          return;
        }
        frame.contentWindow.postMessage({ type: 'kiwi-mermaid-connect' }, '*', [channel.port2]);
      }, { once: true });
      frame.addEventListener('error', () => {
        clearTimeout(connectTimer);
        reject(new Error('Unable to load the isolated Mermaid renderer.'));
      }, { once: true });
      document.body.appendChild(frame);
    }).catch((error) => {
      mermaidRendererPromise = null;
      throw error;
    });

    return mermaidRendererPromise;
  };

  const svgImageUrl = (svg) => {
    if (!/^\s*<svg\b/i.test(svg)) throw new Error('Mermaid returned an invalid SVG image.');
    if (/<(?:script|iframe|object|embed)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg) || /(?:href|src)\s*=\s*["']\s*javascript:/i.test(svg)) {
      throw new Error('Mermaid returned executable SVG markup.');
    }
    return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  };

  window.kiwiRenderMermaid = (root) => {
    const scope = root && root.querySelectorAll ? root : document;
    const nodes = scope.querySelectorAll('.mermaid:not([data-processed="true"])');
    if (!nodes.length) return Promise.resolve();

    return loadMermaidRenderer()
      .then(async (renderer) => {
        for (const node of nodes) {
          try {
            const source = node.textContent || '';
            const svg = await renderer.render(source);
            const imageUrl = svgImageUrl(svg);
            const image = document.createElement('img');
            image.className = 'mermaid-image';
            const description = source.replace(/\s+/g, ' ').trim();
            image.alt = `다이어그램: ${description.slice(0, 240)}${description.length > 240 ? '…' : ''}`;
            image.decoding = 'async';
            image.addEventListener('load', () => URL.revokeObjectURL(imageUrl), { once: true });
            image.addEventListener('error', () => URL.revokeObjectURL(imageUrl), { once: true });
            image.src = imageUrl;
            node.replaceChildren(image);
            node.dataset.processed = 'true';
          } catch (error) {
            // Keep the source-text fallback and continue rendering later diagrams.
            console.warn('Mermaid render failed', error);
          }
        }
      })
      .catch((error) => console.warn('Mermaid renderer unavailable', error));
  };

  const renderDocument = () => {
    window.kiwiRenderMath(document.body);
    window.kiwiRenderMermaid(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderDocument, { once: true });
  } else {
    renderDocument();
  }
})();
