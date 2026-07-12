import { createInertiaApp } from "@inertiajs/react";
import { renderToString } from "react-dom/server";

// Resolved at build time by Vite — all Pages are bundled into the SSR output.
const pages = import.meta.glob<{ default: unknown }>("./Pages/**/*.tsx", { eager: true });

function resolvePage(name: string): unknown {
  const key = `./Pages/${name}.tsx`;
  const mod = pages[key];
  if (!mod) throw new Error(`Inertia SSR: page not found — ${name}`);
  return mod.default;
}

/**
 * Render an Inertia page server-side and return the HTML string.
 * Called by the ClusterKit HTTP server for every POST /render request.
 */
export async function render(page: Record<string, unknown>): Promise<string> {
  return createInertiaApp({
    page,
    render: renderToString,
    resolve: resolvePage,
    setup({ App, props }) {
      return <App {...props} />;
    },
  });
}
