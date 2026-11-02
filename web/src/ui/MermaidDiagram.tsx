import { useEffect, useId, useState } from "react";

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

export function MermaidDiagram({ source }: { source: string }) {
  const base = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis", padding: 10 },
        });
        const out = await mermaid.render(id, source.replace(/^\s*classDef .*$/gm, ""));
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

  if (error) {
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <div className="md-diagram" role="img" aria-label="Diagram">
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="text-ink/45">Loading diagram…</span>}
    </div>
  );
}
