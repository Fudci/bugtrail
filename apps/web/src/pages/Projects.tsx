import { Plus } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { initial, useMe, useProjects } from "../hooks";
import { platformLabel } from "./NewProject";

export function ProjectsPage() {
  const me = useMe().data!;
  const projects = useProjects();
  const navigate = useNavigate();
  const list = projects.data ?? [];

  return (
    <section>
      <div className="hero" style={{ alignItems: "center" }}>
        <div><h1>Projects</h1><p className="sub" style={{ marginTop: 8 }}>{list.length} {list.length === 1 ? "project" : "projects"}</p></div>
        {me.isAdmin && <Link className="btn dark" to="/projects/new"><Plus />Create project</Link>}
      </div>
      {projects.isSuccess && list.length === 0 && !me.isAdmin && (
        <div className="empty">You're not a member of any project yet. Ask an admin for an invite.</div>
      )}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        {list.map((p, idx) => {
          const dark = idx === 0;
          return (
            <div key={p.id} className={`card ${dark ? "dark" : ""}`} style={{ cursor: "pointer" }} onClick={() => navigate(`/p/${p.id}`)}>
              <div className="row between">
                <span className="who" style={{ width: 44, height: 44, color: "var(--dark)" }}>{initial(p.name)}</span>
                <span className="tag" style={dark ? { background: "rgba(255,255,255,.08)", color: "#d9d6cc" } : undefined}>{platformLabel(p.platform)}</span>
              </div>
              <div style={{ fontSize: 20, margin: "26px 0 2px" }}>{p.name}</div>
              <div className={`row between ${dark ? "" : "sub"}`} style={{ fontSize: 13, color: dark ? "#a8a59c" : undefined }}>
                <span><b style={{ color: dark ? "#fff" : "var(--ink)", fontSize: 28, fontWeight: 300 }}>{p.unresolvedIssues}</b> unresolved</span>
                <span>{p.role}</span>
              </div>
            </div>
          );
        })}
        {me.isAdmin && (
          <Link to="/projects/new" className="card p-hatch" style={{ display: "grid", placeItems: "center", boxShadow: "none", minHeight: 180 }}>
            <div style={{ textAlign: "center" }}>
              <span className="iconbtn" style={{ margin: "0 auto 10px", background: "var(--sel)", color: "var(--sel-ink)" }}><Plus /></span>
              New project
            </div>
          </Link>
        )}
      </div>
    </section>
  );
}
