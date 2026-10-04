import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Search, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api, type IssueSummary } from "../api";
import { AssigneePicker } from "../components/AssigneePicker";
import { formatDate, timeAgo, useProject } from "../hooks";

const TABS = [
  { key: "unresolved", label: "Unresolved" },
  { key: "resolved", label: "Resolved" },
  { key: "ignored", label: "Ignored" },
  { key: "all", label: "All" },
] as const;

export function IssuesPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "unresolved";
  const level = params.get("level") ?? "";
  const query = params.get("query") ?? "";
  const release = params.get("release") ?? "";
  const firstRelease = params.get("firstRelease") ?? "";
  const [draft, setDraft] = useState(query);
  const role = useProject().data?.role;
  const isAdmin = role === "admin";
  const canAssign = role === "admin" || role === "member";
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api.post<{ deleted: number }>(`/projects/${projectId}/issues/delete`, { ids }),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["issues", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  // Pilihan dikosongkan saat filter berubah supaya tidak menghapus issue yang tidak terlihat.
  useEffect(() => setSelected(new Set()), [projectId, status, level, query, release, firstRelease]);
  useEffect(() => setDraft(query), [query]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // Filter yang sama dipakai list dan ekspor CSV.
  const filterQs = new URLSearchParams({ status });
  if (level) filterQs.set("level", level);
  if (query) filterQs.set("query", query);
  if (release) filterQs.set("release", release);
  if (firstRelease) filterQs.set("firstRelease", firstRelease);

  const issues = useInfiniteQuery({
    queryKey: ["issues", projectId, status, level, query, release, firstRelease],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams(filterQs);
      qs.set("limit", "25");
      if (pageParam) qs.set("cursor", pageParam);
      return api.get<{ issues: IssueSummary[]; nextCursor: string | null }>(`/projects/${projectId}/issues?${qs}`);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });

  const rows = issues.data?.pages.flatMap((p) => p.issues) ?? [];
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setParam("query", draft.trim());
  };

  return (
    <section>
      <div className="hero" style={{ alignItems: "center" }}>
        <div><h1>Issues</h1><p className="sub" style={{ marginTop: 8 }}>Errors grouped by root cause.</p></div>
      </div>

      <div className="row between" style={{ marginBottom: "var(--s3)", gap: "var(--s3)", flexWrap: "wrap" }}>
        <div className="ptabs">
          {TABS.map((t) => (
            <a key={t.key} className={status === t.key ? "on" : ""} onClick={() => setParam("status", t.key === "unresolved" ? "" : t.key)}>{t.label}</a>
          ))}
        </div>
        <form className="field" style={{ flex: 1, maxWidth: 560 }} onSubmit={onSearch}>
          <Search /><input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search titles and event contents…" />
        </form>
      </div>
      <div className="row" style={{ marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        <select className="select" value={level} onChange={(e) => setParam("level", e.target.value)}>
          <option value="">All levels</option>
          <option value="fatal">Fatal</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <a className="btn sm" href={`/api/0/projects/${projectId}/issues/export?${filterQs}`} download>
          <Download />Export CSV
        </a>
        {isAdmin && selected.size > 0 && (
          <button className="btn sm" style={{ background: "var(--red)", color: "#fff" }} disabled={bulkDelete.isPending}
            onClick={() => confirm(`Permanently delete ${selected.size} ${selected.size === 1 ? "issue" : "issues"} and all their events?`) && bulkDelete.mutate([...selected])}>
            <Trash2 />Delete {selected.size} {selected.size === 1 ? "issue" : "issues"}
          </button>
        )}
        {bulkDelete.isError && <span className="err-msg">{bulkDelete.error.message}</span>}
        {release && <span className="tag acc filter-chip">release {release}<button type="button" className="chip-x" onClick={() => setParam("release", "")} aria-label="Clear filter"><X /></button></span>}
        {firstRelease && <span className="tag acc filter-chip">new in {firstRelease}<button type="button" className="chip-x" onClick={() => setParam("firstRelease", "")} aria-label="Clear filter"><X /></button></span>}
        {query && <span className="tag acc filter-chip">“{query}”<button type="button" className="chip-x" onClick={() => setParam("query", "")} aria-label="Clear filter"><X /></button></span>}
      </div>

      <div className="ihead issues-grid">
        {isAdmin && rows.length > 0 ? (
          <input type="checkbox" className="check" title="Select all" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
            onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
        ) : <span />}
        <span>Issue</span><span>Level</span><span>Last seen</span><span>14 days</span><span>Events</span><span>Assignee</span></div>
      <div className="ilist">
        {issues.isPending && <div className="empty">Loading…</div>}
        {issues.isError && <div className="empty">Failed to load issues: {issues.error.message}</div>}
        {issues.isSuccess && rows.length === 0 && (
          <div className="empty">{query || level || release || firstRelease || status !== "unresolved" ? "No matching issues." : "No errors yet. Install the SDK using the DSN from Settings."}</div>
        )}
        {rows.map((i) => (
          <div key={i.id} className="irow issues-grid" onClick={() => navigate(`/p/${projectId}/issues/${i.id}`)}>
            {isAdmin ? (
              <input type="checkbox" className="check" checked={selected.has(i.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(i.id)} />
            ) : <span className={`lv ${i.level}`} />}
            <div style={{ minWidth: 0 }}>
              <div className="ttl">{i.title}</div>
              <div className="meta">
                {i.culprit && <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.culprit}</span>}
                <span>{i.culprit ? "· " : ""}first seen {formatDate(i.firstSeen)}</span>
                {i.status !== "unresolved" && <span className="tag">{i.status}</span>}
              </div>
            </div>
            <span><span className={`tag ${i.level === "error" || i.level === "fatal" ? "err" : ""}`}>{i.level}</span></span>
            <span><div className="k">{formatDate(i.lastSeen)}</div><div>{timeAgo(i.lastSeen)}</div></span>
            <Spark data={i.spark} />
            <span className="v num">{i.eventCount.toLocaleString("en-US")}</span>
            <AssigneePicker issueId={i.id} projectId={projectId!} assignee={i.assignee} canEdit={canAssign} />
          </div>
        ))}
      </div>
      {issues.hasNextPage && (
        <div className="row" style={{ justifyContent: "center", marginTop: "var(--s5)" }}>
          <button className="btn" onClick={() => issues.fetchNextPage()} disabled={issues.isFetchingNextPage}>
            {issues.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

function Spark({ data }: { data?: number[] }) {
  if (!data) return <span />;
  const max = Math.max(1, ...data);
  return (
    <span className="spark" title={`${data.reduce((a, b) => a + b, 0).toLocaleString("en-US")} events in 14 days`}>
      {data.map((n, i) => <i key={i} className={n ? "" : "z"} style={{ height: `${n ? Math.max(12, (n / max) * 100) : 8}%` }} />)}
    </span>
  );
}
