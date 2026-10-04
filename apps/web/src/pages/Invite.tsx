import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { BrandLogo } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { api, ApiError, type Role } from "../api";
import { useMe } from "../hooks";

interface InviteInfo { email: string; role: Role; project: { id: string; name: string }; hasAccount: boolean }

export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<InviteInfo>(`/invites/${token}`), retry: false });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ projectId: string }>(`/invites/${token}/accept`, info.data?.hasAccount ? {} : { name: name || undefined, password });
      // Undangan sudah terpakai; jangan di-refetch (akan 404).
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "invite" });
      navigate(`/p/${res.projectId}/issues`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to accept invite");
    } finally {
      setBusy(false);
    }
  };

  const body = () => {
    if (info.isPending) return <p className="sub">Loading invite…</p>;
    if (info.isError) return (<><h1 style={{ fontSize: 40 }}>Invalid invite.</h1><p className="sub" style={{ marginTop: 12 }}>This link has already been used or has expired. Ask an admin for a new invite.</p></>);
    const inv = info.data;
    const wrongUser = inv.hasAccount && me.data && me.data.email !== inv.email;
    return (
      <form onSubmit={accept}>
        <h1 style={{ fontSize: 40 }}>Join<br />{inv.project.name}</h1>
        <p className="sub" style={{ margin: "12px 0 28px" }}>Invited as <b>{inv.role}</b> for <span className="mono">{inv.email}</span>.</p>
        {!inv.hasAccount && (
          <>
            <label className="field"><User /><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" autoComplete="name" /></label>
            <label className="field" style={{ marginTop: 10 }}><Lock /><input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a password (min. 10 characters)" autoComplete="new-password" /></label>
          </>
        )}
        {inv.hasAccount && !me.data && (
          <p className="sub">This email already has an account. <Link to="/login" state={{ from: `/invite/${token}` }} style={{ textDecoration: "underline" }}>Sign in</Link> to accept.</p>
        )}
        {wrongUser && <p className="err-msg">You're signed in as {me.data!.email}. Sign out and sign in as {inv.email}.</p>}
        {error && <p className="err-msg">{error}</p>}
        {(!inv.hasAccount || (me.data && !wrongUser)) && (
          <button className="btn dark" style={{ width: "100%", height: 52, marginTop: 22 }} disabled={busy}>Accept invite <ArrowRight /></button>
        )}
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
