# Mermaid CSP isolation

The generated wiki keeps its application document on a strict style policy:
`style-src-attr 'none'` and no `style-src 'unsafe-inline'`.

Mermaid cannot run inside that document because its layout engine creates
temporary style elements and style attributes. Kiwi Mu therefore renders each
diagram in `/static/mermaid-frame.htm`, an invisible iframe with the following
boundary:

- `sandbox="allow-scripts"` gives the frame an opaque origin. It deliberately
  does not receive `allow-same-origin`, forms, popups, or navigation privileges.
- A private transferred `MessagePort` accepts bounded diagram source and
  returns only SVG text. Mermaid runs with `securityLevel: "strict"`.
- Both frame and parent reject executable SVG elements, event handlers, and
  JavaScript URLs. The parent embeds the result as a Blob-backed `<img>`, where
  SVG script execution is disabled.
- Mermaid's required `style-src 'unsafe-inline'` exception exists only in the
  opaque sandbox frame. It does not alter the parent page's CSP.

Because an opaque sandbox origin cannot portably match CSP `self`, the two fixed
external script tags use a frame-only CSP nonce. The nonce is static because the
frame is an immutable build asset, not an authorization secret; its purpose is
to distinguish those two reviewed tags from any Mermaid-generated markup. The
frame also has `connect-src 'none'` and cannot access the parent origin. Any
future script tag, frame content interpolation, or sandbox-token change requires
a security review and a nonce rotation.
