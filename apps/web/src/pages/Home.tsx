import { Navigate } from "react-router";
import { lastProject, useProjects } from "../hooks";

// Arahkan ke project terakhir yang dibuka, atau daftar project.
export function Home() {
  const projects = useProjects();
  if (projects.isPending) return null;
  const list = projects.data ?? [];
  const last = list.find((p) => p.id === lastProject()) ?? list[0];
  return <Navigate to={last ? `/p/${last.id}` : "/projects"} replace />;
}
