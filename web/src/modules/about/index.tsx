import { Link } from "react-router-dom";
import { InfoIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Markdown } from "../../ui/molecules/Markdown";
import pipeline from "../../../../docs/pipeline.md?raw";

function HowItWorks(_: ViewProps) {
  return (
    <div className="sw-container h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 pt-5">
        <Link to="/flow" className="inline-flex items-center gap-1.5 text-sm text-accent-ink hover:underline max-md:py-2">
          <ShareNetworkIcon /> Pipeline flowchart
        </Link>
      </div>
      <Markdown source={pipeline} className="mx-auto max-w-4xl px-6 py-6 [&_td]:align-top [&_td]:[overflow-wrap:normal] [&_th]:[overflow-wrap:normal]" />
    </div>
  );
}

export const aboutModule: FeatureModule = {
  id: "about",
  permission: "viewer",
  nav: { label: "How it works", icon: InfoIcon, to: "/about" },
  commands: [],
  routes: [{ path: "about", view: { id: "about", title: "How it works", panels: [{ id: "pipeline", title: "How it works", component: HowItWorks, defaultSize: 100 }] } }],
};
