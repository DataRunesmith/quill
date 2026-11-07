import secureApp from "./secure-index";
import { accessRoute, requestWithPath, robotsPolicy } from "./access-routing";
import type { Env } from "./db";
import type { SendJobMessage } from "../../shared/types";

export { CredentialRateLimiter } from "./secure-index";

type SecureHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  queue(batch: MessageBatch<SendJobMessage>, env: Env): Promise<void>;
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
};

const app = secureApp as unknown as SecureHandler;

function withRobotsPolicy(response: Response, pathname: string): Response {
  const policy = robotsPolicy(pathname);
  if (!policy) return response;
  const result = new Response(response.body, response);
  result.headers.set("X-Robots-Tag", policy);
  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const externalUrl = new URL(request.url);
    const route = accessRoute(externalUrl.pathname, request.method);

    if (route.type === "redirect") {
      const target = new URL(request.url);
      target.pathname = route.pathname;
      return withRobotsPolicy(
        new Response(null, {
          status: 308,
          headers: {
            Location: target.toString(),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        }),
        externalUrl.pathname,
      );
    }

    const upstreamRequest =
      route.type === "rewrite" ? requestWithPath(request, route.pathname) : request;
    return withRobotsPolicy(await app.fetch(upstreamRequest, env, ctx), externalUrl.pathname);
  },

  queue(batch: MessageBatch<SendJobMessage>, env: Env): Promise<void> {
    return app.queue(batch, env);
  },

  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return app.scheduled(event, env, ctx);
  },
} satisfies ExportedHandler<Env, SendJobMessage>;
