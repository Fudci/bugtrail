import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, AtSign, Lock, Mail, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { BrandLogo } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { api, ApiError, type Role } from "../api";
import { useMe } from "../hooks";

interface InviteInfo { email: string | null; role: Role; project: { id: string; name: string }; hasAccount: boolean }

// Username: sama dengan aturan server (auth/users.ts).
const USERNAME_PATTERN = "[a-z0-9][a-z0-9._\\-]{1,30}[a-z0-9]";

export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<InviteInfo>(`/invites/${token}`), retry: false });
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inv = info.data;
  // Sudah login dan undangan tidak terikat ke email lain: cukup bergabung dengan akun itu.
  const joinAsMe = Boolean(me.data && inv && (!inv.email || me.data.email === inv.email));
  const wrongUser = Boolean(me.data && inv?.email && me.data.email !== inv.email);
  const newAccount = !me.data && inv && !inv.hasAccount;

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ projectId: string }>(`/invites/${token}/accept`,
        newAccount ? { username: username.trim().toLowerCase(), name: name || undefined, email: inv?.email ? undefined : email || undefined, password } : {});
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
    if (info.isError || !inv) return (<><h1 style={{ fontSize: 40 }}>Invalid invite.</h1><p className="sub" style={{ marginTop: 12 }}>This link has already been used or has expired. Ask an admin for a new invite.</p></>);
    return (
      <form onSubmit={accept}>
        <h1 style={{ fontSize: 40 }}>Join<br />{inv.project.name}</h1>
        <p className="sub" style={{ margin: "12px 0 28px" }}>
          Invited as <b>{inv.role}</b>{inv.email && <> for <span className="mono">{inv.email}</span></>}.
          {joinAsMe && <> You'll join as <b>{me.data!.name || me.data!.username}</b>.</>}
        </p>
        {newAccount && (
          <>
            <label className="field"><AtSign /><input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus
              pattern={USERNAME_PATTERN} title="3–32 characters: lowercase letters, numbers, . _ - (not at the start or end)"
              placeholder="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>
            <p className="sub" style={{ fontSize: 12, margin: "6px 0 0 8px" }}>You sign in with this. Lowercase letters, numbers, . _ -</p>
            <label className="field" style={{ marginTop: 10 }}><User /><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" autoComplete="name" /></label>
            {!inv.email && (
              <label className="field" style={{ marginTop: 10 }}><Mail /><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" autoComplete="email" /></label>
            )}
            <label className="field" style={{ marginTop: 10 }}><Lock /><input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a password (min. 10 characters)" autoComplete="new-password" /></label>
            <p className="sub" style={{ fontSize: 13, marginTop: 14 }}>
              Already have an account? <Link to="/login" state={{ from: `/invite/${token}` }} style={{ textDecoration: "underline" }}>Sign in</Link> to join with it.
            </p>
          </>
        )}
        {!me.data && inv.hasAccount && (
          <p className="sub">This email already has an account. <Link to="/login" state={{ from: `/invite/${token}` }} style={{ textDecoration: "underline" }}>Sign in</Link> to accept.</p>
        )}
        {wrongUser && <p className="err-msg">You're signed in as {me.data!.username}. Sign out and sign in as {inv.email}.</p>}
        {error && <p className="err-msg">{error}</p>}
        {(newAccount || joinAsMe) && (
          <button className="btn dark" style={{ width: "100%", height: 52, marginTop: 22 }} disabled={busy}>
            {newAccount ? "Create account and join" : "Join project"} <ArrowRight />
          </button>
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
