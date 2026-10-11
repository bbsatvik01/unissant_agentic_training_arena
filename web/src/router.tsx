import { createBrowserRouter } from "react-router";

import { WorldRoute } from "./routes/WorldRoute";

/**
 * React Router data mode (S6 1.1). The world (D-020) is the room and the hub; the rest of the S6 2.2 route table
 * (onboarding, debrief, arena, leaderboards) arrives with stage 2.
 */
export const router = createBrowserRouter([{ path: "/", element: <WorldRoute /> }]);
