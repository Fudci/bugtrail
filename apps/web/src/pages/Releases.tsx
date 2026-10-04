import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { formatDate, timeAgo } from "../hooks";

interface ReleaseRow {
  release: string;
  events: number;
  issues: number;
  users: number;
  newIssues: number;
  firstSeen: string;
  lastSeen: string;
}

export function ReleasesPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const releases = useQuery({
    queryKey: ["releases", projectId],
    queryFn: () => api.get<ReleaseRow[]>(`/projects/${projectId}/releases`),
    refetchInterval: 60_000,
  });
  const toIssues = (param: "release" | "firstRelease", r: string) =>
    navigate(`/p/${projectId}/issues?status=all&${param}=${encodeURIComponent(r)}`);

  return (
    <section>
      <div className="hero" style={{ alignItems: "center" }}>
        <div>
          <h1>Releases</h1>
          <p className="sub" style={{ marginTop: 8 }}>From the <span className="mono">release</span> field sent by the SDK. Counts reflect events still retained.</p>
        </div>
      </div>

      <div className="ihead releases-grid"><span>Release</span><span>New issues</span><span>Issues</span><span>Events</span><span>Users</span><span>First seen</span></div>
      <div className="ilist">
        {releases.isPending && <div className="empty">Loading…</div>}
        {releases.isError && <div className="empty">Failed to load: {releases.error.message}</div>}
        {releases.isSuccess && releases.data.length === 0 && (
          <div className="empty">No events with a release yet. Set <span className="mono">release</span> in <span className="mono">Sentry.init</span>.</div>
        )}
        {releases.data?.map((r) => (
          <div key={r.release} className="irow releases-grid" onClick={() => toIssues("release", r.release)}>
            <div style={{ minWidth: 0 }}>
              <div className="ttl mono">{r.release}</div>
              <div className="meta">last seen {timeAgo(r.lastSeen)}</div>
            </div>
            <span>
              {r.newIssues > 0 ? (
                <a className="tag err" onClick={(e) => { e.stopPropagation(); toIssues("firstRelease", r.release); }}>+{r.newIssues} new</a>
              ) : <span className="tag">0</span>}
            </span>
            <span className="v num">{r.issues.toLocaleString("en-US")}</span>
            <span className="v num">{r.events.toLocaleString("en-US")}</span>
            <span className="v num">{r.users.toLocaleString("en-US")}</span>
            <span className="k">{formatDate(r.firstSeen)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
