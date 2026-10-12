import { createBrowserRouter } from "react-router";

import { WorldRoute } from "./routes/WorldRoute";

/**
 * React Router data mode (S6 1.1). The world (D-020) holds the hub, the room, onboarding, progress, the debrief and
 * the arena; the trainer and admin consoles (S6 4.12, 4.13) are their own lazy pages, acting only on the referee
 * origin.
 */
export const router = createBrowserRouter([
  { path: "/", element: <WorldRoute /> },
  { path: "/review", lazy: () => import("./routes/ConsoleRoute").then((m) => ({ Component: m.ReviewRoute })) },
  { path: "/admin", lazy: () => import("./routes/ConsoleRoute").then((m) => ({ Component: m.AdminRoute })) },
]);
