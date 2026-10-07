import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { CreatePage } from "./pages/CreatePage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { parseHashRoute } from "./routing";

export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    const updateRoute = () => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  let page;
  switch (route.kind) {
    case "home":
      page = <HomePage />;
      break;
    case "create":
      page = <CreatePage />;
      break;
    case "investigation":
      page = <WorkspacePage key={route.id} id={route.id} />;
      break;
    case "not-found":
      page = <NotFoundPage />;
      break;
  }

  return <AppShell create={route.kind === "create"} home={route.kind === "home"} quiet={route.kind === "investigation"} showNewInvestigationLink={route.kind === "not-found"}>{page}</AppShell>;
}
