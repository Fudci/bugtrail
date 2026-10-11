import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, ApiError, type Me } from "../api";
import { BrandLogo } from "../components/Brand";
import { BugCatcher, BugServer } from "../components/BugCatcher";
import { ThemeToggle } from "../components/ThemeToggle";
import { LoginDemo } from "../components/LoginDemo";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.post<Me>("/auth/login", { login, password });
      qc.setQueryData(["me"], me);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? "/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="login">
      <div className="lg-l">
        <div className="row between" style={{ alignSelf: "stretch" }}>
          <BrandLogo size={40} />
          <ThemeToggle />
        </div>
        <form className="lg-form" onSubmit={submit}>
          <h1 style={{ fontSize: 46 }}>Welcome<br />back.</h1>
          <p className="sub" style={{ margin: "12px 0 28px" }}>Sign in to monitor your team's app errors.</p>
          <label className="field"><User /><input required autoComplete="username" autoCapitalize="none" spellCheck={false} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Username or email" /></label>
          <label className="field"><Lock /><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" /></label>
          {error && <p className="err-msg">{error}</p>}
          <button className="btn dark" style={{ width: "100%", height: 52, marginTop: 22 }} disabled={busy}>
            Sign in <ArrowRight />
          </button>
          <p className="sub" style={{ marginTop: 22, fontSize: 13 }}>Don't have an account? Ask your team admin for an invite.</p>
        </form>
      </div>
      <div className="lg-r">
        <div className="row between" style={{ position: "relative" }}>
          <span className="row" style={{ gap: 10 }}>
            <span className="tag acc"><span className="lf-dot" />Live</span>
            <span style={{ fontSize: 12, color: "#8f8c83" }}>Example data</span>
          </span>
          <BugServer />
        </div>
        <LoginDemo />
        <div style={{ position: "relative", fontSize: 26, fontWeight: 300, letterSpacing: "-.02em", lineHeight: 1.25 }}>
          Catch errors<br />before users complain.
        </div>
      </div>
      <BugCatcher serverId="bt-server" />
    </section>
  );
}
