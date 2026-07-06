import type { Env } from "../types";

// Model names change over time. Verify the current catalog with `wrangler ai models`
// and update if a better instruct model is available.
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const SYSTEM_PROMPT =
  "You convert a description into a single valid Mermaid diagram. " +
  "Reply with ONLY the Mermaid source code — no prose, no markdown fences, no explanation. " +
  "Prefer 'flowchart TD' unless a sequence or state diagram fits better.";

/**
 * POST /api/ai/diagram  { "prompt": "user signs up then verifies email" }
 * -> { "mermaid": "flowchart TD\n ..." }
 *
 * The browser converts the returned Mermaid into Excalidraw elements with
 * @excalidraw/mermaid-to-excalidraw and inserts them onto the canvas.
 */
export async function handleAi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/ai/diagram" && request.method === "POST") {
    const body = (await safeJson(request)) as { prompt?: string };
    const prompt = (body.prompt || "").trim();
    if (!prompt) return json({ error: "prompt required" }, 400);

    try {
      const result = (await env.AI.run(TEXT_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt.slice(0, 2000) },
        ],
        max_tokens: 512,
      })) as { response?: string };

      const mermaid = cleanMermaid(result.response || "");
      if (!mermaid) return json({ error: "empty generation" }, 502);
      return json({ mermaid });
    } catch (err) {
      return json({ error: "ai error", detail: String(err) }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}

/** Strip stray markdown fences / leading chatter the model sometimes adds. */
function cleanMermaid(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  return t;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
