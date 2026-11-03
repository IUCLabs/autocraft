import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// Renders a Mermaid diagram. The mermaid package is a dynamic import, so it
// loads only on pages that have a ```mermaid block. Security level "strict"
// encodes HTML in labels and disables click handlers. Colours come from the
// design tokens (tokens.css) and are read again when the theme class changes.

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgbVar(name: string, alpha?: number): string {
  const [r, g, b] = token(name).split(/\s+/).map(Number);
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hex(rgbText: string): string {
  const m = rgbText.match(/\d+/g);
  if (!m) return "#888888";
  return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

function themeFor() {
  const fg = hex(rgbVar("--st-fg-rgb"));
  const panel = token("--st-panel");
  const line = hex(rgbVar("--st-fg-rgb")); // edges and borders at readable contrast
  const fill = (v: string) => rgbVar(v, 0.2);
  const stroke = (v: string) => rgbVar(v);
  const kinds: [string, string][] = [
    ["person", "--st-warn-rgb"],
    ["model", "--st-accent-rgb"],
    ["sandbox", "--st-ok-rgb"],
    ["write", "--st-bad-rgb"],
  ];
  const themeCSS = kinds
    .map(
      ([cls, v]) =>
        `.node.${cls} > *,.node.${cls} polygon,.node.${cls} path{fill:${fill(v)} !important;stroke:${stroke(v)} !important;stroke-width:1.5px !important}` +
        `.node.${cls} .nodeLabel,.node.${cls} .nodeLabel *{color:${fg} !important}`,
    )
    .join("") +
    `.edgeLabel,.edgeLabel *{background-color:${panel} !important;color:${fg} !important}` +
    `.cluster rect{fill:transparent !important;stroke:${rgbVar("--st-fg-rgb", 0.3)} !important;stroke-dasharray:4 3}` +
    `.cluster .nodeLabel{color:${fg} !important}`;
  return {
    theme: "base" as const,
    themeCSS,
    themeVariables: {
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: "14px",
      background: panel,
      textColor: fg,
      primaryColor: token("--st-raised"),
      primaryTextColor: fg,
      primaryBorderColor: rgbVar("--st-fg-rgb", 0.5),
      lineColor: line,
      mainBkg: token("--st-raised"),
      nodeBorder: rgbVar("--st-fg-rgb", 0.5),
      clusterBkg: "transparent",
      edgeLabelBackground: panel,
    },
  };
}

// The dashboard CSP has no 'unsafe-inline' for styles, so the browser drops
// <style> elements and style="" attributes in inserted markup. Both are routed
// through CSSOM instead, which style-src does not restrict: <style> text goes
// into a constructable stylesheet, style attributes become el.style.cssText.
function parseSvg(markup: string): { svg: SVGSVGElement; css: string } | null {
  // HTML parsing, because label HTML inside foreignObject is not well-formed XML.
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const svg = doc.body.querySelector("svg");
  if (!svg) return null;
  let css = "";
  svg.querySelectorAll("style").forEach((el) => {
    css += (el.textContent ?? "") + "\n";
    el.remove();
  });
  return { svg, css };
}

function mountSvg(host: HTMLElement, parsed: { svg: SVGSVGElement; css: string }): CSSStyleSheet | null {
  const node = document.importNode(parsed.svg, true);
  const styled: [Element, string][] = [];
  node.querySelectorAll("[style]").forEach((el) => {
    styled.push([el, el.getAttribute("style") ?? ""]);
    el.removeAttribute("style");
  });
  if (node.hasAttribute("style")) {
    styled.push([node, node.getAttribute("style") ?? ""]);
    node.removeAttribute("style");
  }
  host.replaceChildren(node);
  for (const [el, text] of styled) (el as SVGElement | HTMLElement).style.cssText = text;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(parsed.css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return sheet;
}

export function MermaidDiagram({ source }: { source: string }) {
  const base = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A fresh id per render: mermaid leaves a scratch element behind under the id it was given.
    const id = `${base}t${themeTick}`;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        const t = themeFor();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: t.theme,
          themeCSS: t.themeCSS,
          themeVariables: t.themeVariables,
          // Natural size: a wide diagram scrolls sideways instead of shrinking.
          flowchart: { useMaxWidth: false, htmlLabels: false, curve: "basis", padding: 10 },
          sequence: { useMaxWidth: false },
        });
        const src = source.replace(/^\s*classDef .*$/gm, "");
        // Mermaid measures text in a scratch element whose <style> the CSP drops, so
        // the first pass measures with the wrong font and clips labels. Its stylesheet
        // is adopted up front for the second pass, which measures with the real one.
        const first = await mermaid.render(id, src);
        const probe = parseSvg(first.svg);
        const warm = new CSSStyleSheet();
        warm.replaceSync(probe?.css ?? "");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, warm];
        let out;
        try {
          out = await mermaid.render(id, src);
        } finally {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== warm);
        }
        if (!cancelled) {
          setSvg(out.svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, base, themeTick]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!svg || !host) return;
    const parsed = parseSvg(svg);
    if (!parsed) {
      setError("Invalid diagram SVG");
      return;
    }
    const sheet = mountSvg(host, parsed);
    return () => {
      if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
    };
  }, [svg]);

  if (error) {
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <div className="md-diagram" role="img" aria-label="Diagram">
      {svg ? <div ref={hostRef} /> : <span className="text-ink/45">Loading diagram…</span>}
    </div>
  );
}
