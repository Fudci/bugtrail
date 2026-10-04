import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, type Me, type ProjectDetail, type ProjectSummary } from "./api";

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/auth/me"), retry: false });
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectSummary[]>("/projects") });

export function useProject() {
  const { projectId } = useParams();
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.get<ProjectDetail>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

const LAST_PROJECT = "bugtool:lastProject";
export const rememberProject = (id: string) => localStorage.setItem(LAST_PROJECT, id);
export const lastProject = () => localStorage.getItem(LAST_PROJECT);

export const initial = (s: string | null | undefined) => (s?.trim()[0] ?? "?").toUpperCase();

const fmt = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
export const formatDate = (iso: string) => fmt.format(new Date(iso));

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
