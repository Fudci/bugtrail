import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { BrandLogo } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { api, ApiError } from "../api";

// Link reset password dari admin (tanpa email): isi password baru, lalu langsung masuk.
export function ResetPasswordPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["password-reset", token], queryFn: () => api.get<{ username: string }>(`/password-reset/${token}`), retry: false });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/password-reset/${token}`, { password });
      // Link sudah terpakai; jangan di-refetch (akan 404).
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "password-reset" });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reset password");
    } finally {
      setBusy(false);
    }
  };

  const body = () => {
    if (info.isPending) return <p className="sub">Loading…</p>;
    if (info.isError) return (<><h1 style={{ fontSize: 40 }}>Invalid link.</h1><p className="sub" style={{ marginTop: 12 }}>This link has already been used or has expired. Ask an admin for a new one.</p></>);
    return (
      <form onSubmit={submit}>
        <h1 style={{ fontSize: 40 }}>New<br />password.</h1>
        <p className="sub" style={{ margin: "12px 0 28px" }}>For <b>@{info.data.username}</b>. Other devices will be signed out.</p>
        <label className="field"><Lock /><input type="password" required minLength={10} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (min. 10 characters)" autoComplete="new-password" /></label>
        <label className="field" style={{ marginTop: 10 }}><Lock /><input type="password" required minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat the password" autoComplete="new-password" /></label>
        {error && <p className="err-msg">{error}</p>}
        <button className="btn dark" style={{ width: "100%", height: 52, marginTop: 22 }} disabled={busy}>Save and sign in <ArrowRight /></button>
      </form>
    );
  };

  return (
    <section className="login">
      <div className="lg-l">
        <div className="row between" style={{ alignSelf: "stretch" }}>
          <BrandLogo size={40} />
          <ThemeToggle />
        </div>
        <div className="lg-form">{body()}</div>
      </div>
      <div className="lg-r">
        <div />
        <div style={{ position: "relative", fontSize: 26, fontWeight: 300, letterSpacing: "-.02em", lineHeight: 1.25 }}>
          Catch errors<br />before users complain.
        </div>
      </div>
    </section>
  );
}
