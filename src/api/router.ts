/**
 * Simple path-based HTTP router.
 * Supports parameterized paths like /api/sessions/:id.
 * Zero dependencies.
 */

export interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

export interface HandlerMap {
  [key: string]: RouteHandler;
}

export interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
  match: (method: string, path: string) => Record<string, string> | null;
}

/**
 * Build a route table from a handler map.
 * Keys in the handler map are "METHOD /path" strings.
 * Path segments starting with : are treated as parameters.
 */
export function createRouter(handlers: HandlerMap): Route[] {
  const routes: Route[] = [];

  for (const [key, handler] of Object.entries(handlers)) {
    const [method, pattern] = key.split(" ", 2);
    const segments = pattern.split("/").filter(Boolean);

    routes.push({
      method,
      pattern,
      handler,
      match: (reqMethod: string, reqPath: string) => {
        if (reqMethod !== method) return null;

        const reqSegments = reqPath.split("/").filter(Boolean);
        if (reqSegments.length !== segments.length) return null;

        const params: Record<string, string> = {};
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].startsWith(":")) {
            params[segments[i].slice(1)] = decodeURIComponent(reqSegments[i]);
          } else if (segments[i] !== reqSegments[i]) {
            return null;
          }
        }

        return params;
      },
    });
  }

  return routes;
}
