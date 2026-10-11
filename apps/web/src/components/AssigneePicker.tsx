import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Search, UserMinus, UserPlus } from "lucide-react";
import { useState } from "react";
import { api, type Member, type Person } from "../api";
import { initial, personName, useMe } from "../hooks";
import { Popover } from "./Popover";

// Tombol assignee di daftar issue: kosong = ikon "assign", terisi = avatar; klik untuk pilih anggota.
export function AssigneePicker({ issueId, projectId, assignee, canEdit }: { issueId: string; projectId: string; assignee: Person | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const [find, setFind] = useState("");
  const me = useMe().data;
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api.get<{ members: Member[] }>(`/projects/${projectId}/members`),
    enabled: canEdit,
    staleTime: 60_000,
  });
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) => api.patch(`/issues/${issueId}`, { assigneeId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issues", projectId] });
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
    },
  });

  const label = assignee ? `Assigned to ${personName(assignee)}` : "Unassigned";
  const face = assignee
    ? <span className="who">{initial(personName(assignee))}</span>
    : <span className="who assign"><UserPlus /></span>;
  if (!canEdit) return <span title={label}>{face}</span>;

  return (
    // Klik di sini tidak boleh membuka halaman detail (baris issue bisa diklik).
    <span onClick={(e) => e.stopPropagation()}>
      <Popover align="right" trigger={(toggle) => (
        <button type="button" className="assign-btn" title={`${label} — click to ${assignee ? "change" : "assign"}`} onClick={() => { setFind(""); toggle(); }} disabled={assign.isPending}>
          {face}
        </button>
      )}>
        {(close) => {
          const pick = (id: string | null) => { assign.mutate(id); close(); setFind(""); };
          const q = find.trim().toLowerCase();
          const list = (members.data?.members ?? []).filter((m) => !q || m.username.includes(q) || (m.email ?? "").toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
          return (
            <>
              <div className="cap">Assign to</div>
              {me && assignee?.id !== me.id && !q && <a onClick={() => pick(me.id)}><UserPlus />Assign to me</a>}
              {(members.data?.members.length ?? 0) > 5 && (
                <label className="pop-search"><Search />
                  <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search name or username…"
                    onKeyDown={(e) => { if (e.key === "Enter" && list[0]) pick(list[0].id); }} />
                </label>
              )}
              {members.isPending && <div className="cap">Loading…</div>}
              {members.isSuccess && list.length === 0 && <div className="cap">No member matches “{find}”.</div>}
              <div className="pop-list">
              {list.map((m) => (
                <a key={m.id} onClick={() => pick(m.id)}>
                  <span className="who" style={{ width: 22, height: 22, fontSize: 10 }}>{initial(personName(m))}</span>
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span className="ellip">{personName(m)}</span>
                    {m.name && <span className="ellip" style={{ fontSize: 11.5, color: "var(--mute)" }}>@{m.username}</span>}
                  </span>
                  {assignee?.id === m.id && <Check style={{ marginLeft: "auto" }} />}
                </a>
              ))}
              </div>
              {assignee && (<><hr /><a onClick={() => pick(null)}><UserMinus />Unassign</a></>)}
            </>
          );
        }}
      </Popover>
    </span>
  );
}
