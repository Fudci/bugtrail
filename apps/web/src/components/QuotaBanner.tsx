import { TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { useProject } from "../hooks";

// Banner di Overview/API Health kalau project membuang data karena kuota dalam satu jam terakhir.
export function QuotaBanner() {
  const p = useProject().data;
  if (!p?.overQuota) return null;
  return (
    <div className="quota-banner" role="status">
      <TriangleAlert />
      <span>
        This project is over its quota — some data was dropped.{" "}
        {p.role === "admin" ? <Link to={`/p/${p.id}/settings`}>Adjust quotas in Settings.</Link> : "Adjust quotas in Settings."}
      </span>
    </div>
  );
}
