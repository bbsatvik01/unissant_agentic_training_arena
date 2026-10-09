import { createBrowserRouter } from "react-router";

import { Placeholder } from "./routes/placeholder";

/** React Router data mode (S6 1.1). The S6 2.2 route table arrives with the slice UI (WP-19). */
export const router = createBrowserRouter([{ path: "/", element: <Placeholder /> }]);
