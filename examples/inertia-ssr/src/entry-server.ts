import { createInertiaApp } from "@inertiajs/vue3";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";

// Resolved at build time by Vite — all Pages are bundled into the SSR output.
const pages = import.meta.glob<{ default: unknown }>("./Pages/**/*.vue", { eager: true });

function resolvePage(name: string): unknown {
  const key = `./Pages/${name}.vue`;
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
    setup({ App, props, plugin }) {
      return createSSRApp({ render: () => h(App, props) }).use(plugin);
    },
  });
}
