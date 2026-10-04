import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Atom, Feather, Folder, Server, Smartphone, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { api, type IssueSummary } from "../api";
import { useMe } from "../hooks";

interface Platform { key: string; label: string; icon: LucideIcon; install: string; init: (dsnVar: string) => string }

// Snippet memakai SDK Sentry resmi; DSN dibaca dari env, bukan di-hardcode.
const PLATFORMS: Platform[] = [
  {
    key: "react-native", label: "React Native", icon: Smartphone,
    install: "npx @sentry/wizard@latest -i reactNative\n# or: npm install @sentry/react-native",
    init: () => `import * as Sentry from "@sentry/react-native";\nimport Config from "react-native-config";\n\nSentry.init({ dsn: Config.SENTRY_DSN });`,
  },
  {
    key: "node", label: "Node.js", icon: Server,
    install: "pnpm add @sentry/node",
    init: () => `import * as Sentry from "@sentry/node";\n\nSentry.init({ dsn: process.env.SENTRY_DSN });`,
  },
  {
    key: "react", label: "React web", icon: Atom,
    install: "pnpm add @sentry/react",
    init: () => `import * as Sentry from "@sentry/react";\n\nSentry.init({ dsn: import.meta.env.VITE_SENTRY_DSN });`,
  },
  {
    key: "flutter", label: "Flutter", icon: Feather,
    install: "flutter pub add sentry_flutter",
    init: () => `import 'package:sentry_flutter/sentry_flutter.dart';\n\nFuture<void> main() async {\n  await SentryFlutter.init(\n    (options) => options.dsn = const String.fromEnvironment('SENTRY_DSN'),\n    appRunner: () => runApp(const MyApp()),\n  );\n}`,
  },
];

const envLine = (key: string, dsn: string) => {
  switch (key) {
    case "react": return `# .env\nVITE_SENTRY_DSN=${dsn}`;
    case "flutter": return `# build / run\nflutter run --dart-define=SENTRY_DSN=${dsn}`;
    default: return `# .env\nSENTRY_DSN=${dsn}`;
  }
};

export const platformLabel = (key: string | null) => PLATFORMS.find((p) => p.key === key)?.label ?? key ?? "—";

export function NewProjectPage() {
  const me = useMe().data!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [platform, setPlatform] = useState(PLATFORMS[0]!.key);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; name: string; dsn: string }>("/projects", { name: name.trim(), platform }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setStep(3);
    },
  });
  const created = create.data;

  // Step 3: cek tiap 3 detik apakah event pertama sudah masuk.
  const firstEvent = useQuery({
    queryKey: ["first-event", created?.id],
    queryFn: () => api.get<{ issues: IssueSummary[] }>(`/projects/${created!.id}/issues?status=all&limit=1`),
    enabled: Boolean(created),
    refetchInterval: (q) => (q.state.data?.issues.length ? false : 3000),
  });
  const gotEvent = Boolean(firstEvent.data?.issues.length);

  if (!me.isAdmin) return <Navigate to="/projects" replace />;
  const plat = PLATFORMS.find((p) => p.key === platform)!;
  const stepClass = (n: number) => (step === n ? "on" : step > n ? "done" : "todo");

  return (
    <section style={{ maxWidth: 900 }}>
      <Link to="/projects" className="btn sm" style={{ marginBottom: "var(--s4)" }}><ArrowLeft />Projects</Link>
      <h1 style={{ marginBottom: "var(--s5)" }}>New project</h1>
      <div className="steps">
        <div className={stepClass(1)}>1 · Platform</div>
        <div className={stepClass(2)}>2 · Detail</div>
        <div className={stepClass(3)}>3 · Install SDK</div>
      </div>

      {step === 1 && (
        <div className="screen-in">
          <p className="sub" style={{ marginBottom: 14 }}>What is your app built with?</p>
          <div className="plat">
            {PLATFORMS.map((p) => (
              <label key={p.key}>
                <input type="radio" name="pl" checked={platform === p.key} onChange={() => setPlatform(p.key)} />
                <span className="pi"><p.icon /></span><span>{p.label}</span>
              </label>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: "var(--s5)" }}>
            <button className="btn dark" onClick={() => setStep(2)}>Next<ArrowRight /></button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form className="screen-in" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <div className="card">
            <p className="lbl2">Project name</p>
            <label className="field"><Folder /><input className="mono" autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="hrms-mobile" /></label>
            {create.isError && <p className="err-msg">{create.error.message}</p>}
          </div>
          <div className="row between" style={{ marginTop: "var(--s5)" }}>
            <button type="button" className="btn" onClick={() => setStep(1)}><ArrowLeft />Back</button>
            <button className="btn dark" disabled={create.isPending || !name.trim()}>Create project<ArrowRight /></button>
          </div>
        </form>
      )}

      {step === 3 && created && (
        <div className="screen-in">
          <p className="lbl2">1 · Install</p>
          <pre className="code">{plat.install}</pre>
          <p className="lbl2" style={{ marginTop: 20 }}>2 · Store the DSN in your environment</p>
          <pre className="code">{envLine(plat.key, created.dsn)}</pre>
          <p className="lbl2" style={{ marginTop: 20 }}>3 · Initialize</p>
          <pre className="code">{plat.init("SENTRY_DSN")}</pre>
          <p className="lbl2" style={{ marginTop: 20 }}>4 · Send a test error</p>
          <div className="waiting">
            {gotEvent ? <>✓ First event received!</> : <><span className="pulse" />Waiting for the first event from your app…</>}
          </div>
          <div className="row between" style={{ marginTop: "var(--s5)" }}>
            <Link className="sub" to={`/p/${created.id}/settings`}>Skip for now</Link>
            <button className="btn dark" onClick={() => navigate(`/p/${created.id}/issues`)}>Go to issues<ArrowRight /></button>
          </div>
        </div>
      )}
    </section>
  );
}
