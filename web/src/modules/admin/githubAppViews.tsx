import { useState } from "react";
import { useQuery } from "../../api/client";
import type { GithubAppStatus } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { TextLink } from "../../ui/atoms/TextLink";
import { Block } from "../../ui/molecules/Block";
import { Facts } from "../../ui/molecules/Facts";
import { Page } from "../../ui/organisms/Page";

const LOGIN_MODE = { oauth: "OAuth App", "github-app": "GitHub App" } as const;

export function GithubAppView(_: ViewProps) {
  const { data, error } = useQuery("github-app", (api) => api.githubApp.status());
  return (
    <Page title="GitHub App">
      <ErrorLine error={error?.message} className="mt-3" />
      {data && (
        <>
          <AppBlock s={data} />
          {data.app && <Installations s={data} />}
        </>
      )}
    </Page>
  );
}

function AppBlock({ s }: { s: GithubAppStatus }) {
  return (
    <Block className="mt-4" title="App" aside={<Badge tone={s.configured ? "ok" : "neutral"}>{s.configured ? "Registered" : "Not registered"}</Badge>}>
      <div className="px-4 py-3">
        {s.app ? (
          <>
            <Facts
              rows={[
                ["Name", s.app.name],
                ["Slug", <code key="slug">{s.app.slug}</code>],
                ["App id", <code key="id">{s.app.id}</code>],
                ["Sign-in", LOGIN_MODE[s.loginMode]],
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <TextLink href={s.app.installUrl}>Install</TextLink>
              <TextLink href={s.app.transferUrl}>Transfer</TextLink>
            </div>
          </>
        ) : (
          <RegisterForm s={s} />
        )}
      </div>
    </Block>
  );
}

function RegisterForm({ s }: { s: GithubAppStatus }) {
  const [name, setName] = useState(s.defaultName);
  const [org, setOrg] = useState("");
  return (
    <>
      <Facts rows={[["Sign-in", LOGIN_MODE[s.loginMode]]]} className="mb-3" />
      <form method="post" action="/auth/github-app/start" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="csrf" value={s.csrf} />
        <Input name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={34} aria-label="App name" className="w-full sm:w-52" />
        <Input name="org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization (optional)" aria-label="Organization" className="w-full sm:w-52" />
        <Button type="submit" variant="primary" disabled={!s.canRegister || !name.trim()} className="max-md:h-11 max-md:w-full">
          Register on GitHub
        </Button>
      </form>
    </>
  );
}

function Installations({ s }: { s: GithubAppStatus }) {
  return (
    <Block className="mt-4" title="Installations">
      <ErrorLine error={s.error} className="px-4 pt-3" />
      {s.installations.length === 0 && !s.error && <div className="px-4 py-3 text-sm text-ink/55">Not installed anywhere yet.</div>}
      <ul>
        {s.installations.map((i) => (
          <li key={i.owner} className="border-b border-line px-4 py-3 last:border-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              {i.owner}
              <Badge>{i.selection === "all" ? "All repos" : `${i.repos.length} repos`}</Badge>
            </div>
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink/70">
              {i.repos.map((r) => (
                <li key={r} className="min-w-0 break-all">
                  {r}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Block>
  );
}
