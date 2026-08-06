import { NextRequest } from "next/server";
import { authenticateWorkspace, relayJson, workspaceFetch } from "@/lib/workspace/proxy";

/**
 * Multipart upload passthrough: the body stream and its multipart content-type
 * boundary are forwarded verbatim — nothing is buffered or parsed here.
 */
export async function POST(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const dir = req.nextUrl.searchParams.get("dir") ?? "";
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/upload?dir=${encodeURIComponent(dir)}`,
    {
      method: "POST",
      body: req.body,
      duplex: "half",
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }
  );
  return relayJson(upstream);
}
