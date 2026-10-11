import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ApiError } from "./api";
import { Layout, RequireAuth } from "./components/Layout";
import { Home } from "./pages/Home";
import { InvitePage } from "./pages/Invite";
import { IssueDetailPage } from "./pages/IssueDetail";
import { IssuesPage } from "./pages/Issues";
import { LoginPage } from "./pages/Login";
import { NewProjectPage } from "./pages/NewProject";
import { OverviewPage } from "./pages/Overview";
import { TracePage } from "./pages/Trace";
import { TracesPage } from "./pages/Traces";
import { HealthPage } from "./pages/Health";
import { ServicesPage } from "./pages/Services";
import { LogsPage } from "./pages/Logs";
import { ResetPasswordPage } from "./pages/ResetPassword";
import { ProjectsPage } from "./pages/Projects";
import { ReleasesPage } from "./pages/Releases";
import { SettingsPage } from "./pages/Settings";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // 401/403/404 tidak akan berubah dengan retry.
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  { path: "/reset-password/:token", element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Home /> },
          { path: "projects", element: <ProjectsPage /> },
          { path: "projects/new", element: <NewProjectPage /> },
          { path: "p/:projectId", element: <OverviewPage /> },
          { path: "p/:projectId/issues", element: <IssuesPage /> },
          { path: "p/:projectId/issues/:issueId", element: <IssueDetailPage /> },
          { path: "p/:projectId/health", element: <HealthPage /> },
          { path: "p/:projectId/services", element: <ServicesPage /> },
          { path: "p/:projectId/traces", element: <TracesPage /> },
          { path: "p/:projectId/logs", element: <LogsPage /> },
          { path: "p/:projectId/traces/:traceId", element: <TracePage /> },
          { path: "p/:projectId/releases", element: <ReleasesPage /> },
          { path: "p/:projectId/settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
