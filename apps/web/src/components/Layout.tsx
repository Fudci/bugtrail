import { useQueryClient } from "@tanstack/react-query";
import { Bug, BugOff, Check, ChevronsUpDown, LayoutGrid, LogOut, Plus, Search, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { initial, personName, rememberProject, useMe, useProjects } from "../hooks";
import { BrandLogo } from "./Brand";
import { Popover } from "./Popover";
import { BugCatcher, BugServer } from "./BugCatcher";
import { ThemeToggle } from "./ThemeToggle";

export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return null;
  if (me.isError) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}


export function Layout() {
  const me = useMe().data!;
  const projects = useProjects();
  const [bugsOn, setBugsOn] = useState(() => localStorage.getItem("bt_bugs") !== "off");
  const { projectId } = useParams();
  const navigate = useNavigate();
  const loc = useLocation();
  // Halaman detail trace: sorot menu asal (Traces bila dari pencarian, selain itu API Health).
  const onTrace = /^\/p\/[^/]+\/traces\/[^/]+/.test(loc.pathname);
  const fromTraces = typeof (loc.state as { fromTraces?: unknown } | null)?.fromTraces === "string";
  // Trace dibuka dari halaman Logs: sorot menu Logs (bukan API Health).
  const fromLogs = typeof (loc.state as { fromLogs?: unknown } | null)?.fromLogs === "string";
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");

  const current = projects.data?.find((p) => p.id === projectId);
  useEffect(() => {
    if (projectId) rememberProject(projectId);
  }, [projectId]);

  // "/" fokus ke pencarian, seperti di mockup.


  const logout = async () => {
    await api.post("/auth/logout");
    qc.clear();
    navigate("/login");
  };

  const visible = projects.data?.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())) ?? [];

  return (
    <div className="app">
      <header className="yt" id="bt-header">
        <div className="yt-l">
          <Link className="yt-logo" to="/">
            <BrandLogo size={30} />
          </Link>
        </div>
        {/* Hiasan: kumbang yang bisa ditangkap, merayap di sepanjang header saja supaya tidak mengganggu konten. */}
        <div className="yt-c" />
        {bugsOn && <BugCatcher serverId="bt-server-hdr" laneId="bt-header" count={[2, 5]} size={[24, 30]} duration={[6000, 22_000]} />}
        <div className="yt-r">
          {bugsOn && <BugServer id="bt-server-hdr" compact />}
          <button type="button" className={`iconbtn ghost ${bugsOn ? "" : "off"}`} title={bugsOn ? "Hide bugs" : "Show bugs"} aria-label="Toggle bugs"
            onClick={() => { localStorage.setItem("bt_bugs", bugsOn ? "off" : "on"); setBugsOn(!bugsOn); }}>
            {bugsOn ? <Bug /> : <BugOff />}
          </button>
          <ThemeToggle />
          {me.isAdmin && (
            <Link className="btn sm" to="/projects/new"><Plus />Create</Link>
          )}
          <Popover
            align="right"
            trigger={(toggle) => <a className="yt-av" onClick={toggle}>{initial(personName(me))}</a>}
          >
            {(close) => (
              <>
                <div className="cap">@{me.username}{me.email ? ` · ${me.email}` : ""}</div>
                {projectId && <Link to={`/p/${projectId}/settings`} onClick={close}><Settings />Settings</Link>}
                <hr />
                <a onClick={logout}><LogOut />Sign out</a>
              </>
            )}
          </Popover>
        </div>
      </header>

      {projectId && (
        <div className="top">
          <Popover
            trigger={(toggle) => (
              <div className="proj" onClick={toggle}>
                <span className="av">{initial(current?.name)}</span>
                <span className="t"><b>{current?.name ?? "…"}</b><span>{current?.platform ?? current?.role}</span></span>
                <ChevronsUpDown style={{ color: "var(--mute)", margin: "0 6px" }} />
              </div>
            )}
          >
            {(close) => (
              <>
                <label className="field" style={{ height: 40, marginBottom: 6 }}>
                  <Search /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a project…" />
                </label>
                {visible.map((p) => (
                  <Link key={p.id} to={`/p/${p.id}`} onClick={close}>
                    <span className="who" style={p.id === projectId ? { background: "var(--dark)", color: "var(--accent)" } : undefined}>{initial(p.name)}</span>
                    {p.name}
                    {p.id === projectId ? <Check style={{ marginLeft: "auto" }} /> : p.unresolvedIssues > 0 && <span className="tag err" style={{ marginLeft: "auto" }}>{p.unresolvedIssues}</span>}
                  </Link>
                ))}
                <hr />
                <Link to="/projects" onClick={close}><LayoutGrid />All projects</Link>
                {me.isAdmin && <Link to="/projects/new" onClick={close}><Plus />New project</Link>}
              </>
            )}
          </Popover>
          <span className="sepv" />
          <nav className="pillnav">
            <NavLink to={`/p/${projectId}`} end className={({ isActive }) => (isActive ? "on" : "")}>Overview</NavLink>
            <NavLink to={`/p/${projectId}/issues`} className={({ isActive }) => (isActive ? "on" : "")} end={false}>
              Issues
            </NavLink>
            <NavLink to={`/p/${projectId}/health`} className={({ isActive }) => (isActive || (onTrace && !fromTraces && !fromLogs) ? "on" : "")}>API Health</NavLink>
            <NavLink to={`/p/${projectId}/services`} className={({ isActive }) => (isActive ? "on" : "")}>Services</NavLink>
            <NavLink to={`/p/${projectId}/traces`} end className={({ isActive }) => (isActive || (onTrace && fromTraces) ? "on" : "")}>Traces</NavLink>
            <NavLink to={`/p/${projectId}/logs`} className={({ isActive }) => (isActive || (onTrace && fromLogs) ? "on" : "")}>Logs</NavLink>
            <NavLink to={`/p/${projectId}/releases`} className={({ isActive }) => (isActive ? "on" : "")}>Releases</NavLink>
            <NavLink to="/projects" className={({ isActive }) => (isActive ? "on" : "")}>Projects</NavLink>
          </nav>
          <NavLink to={`/p/${projectId}/settings`} className={({ isActive }) => `chip-nav ${isActive ? "on" : ""}`}>
            <Settings />Settings
          </NavLink>
        </div>
      )}

      <main className="screen-in" key={useLocation().pathname}>
        <Outlet />
      </main>
    </div>
  );
}
