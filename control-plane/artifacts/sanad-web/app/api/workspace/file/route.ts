import { NextRequest } from "next/server";
import { err } from "@/lib/http/envelope";
import {
  authenticateWorkspace,
  relayJson,
  relayStream,
  workspaceFetch,
} from "@/lib/workspace/proxy";

export async function GET(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return err(400, "invalid_request", "Missing path");
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/file?path=${encodeURIComponent(path)}`,
    { sessionId }
  );
  const download = req.nextUrl.searchParams.get("download") === "1";
  return relayStream(upstream, download ? "attachment" : "inline");
}

export async function PUT(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return err(400, "invalid_request", "Missing path");
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/file?path=${encodeURIComponent(path)}`,
    { sessionId, method: "PUT", body: req.body, duplex: "half" }
  );
  return relayJson(upstream);
}

export async function DELETE(req: NextRequest) {
  const gate = await authenticateWorkspace();
  if (!gate.ok) return gate.response;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return err(400, "invalid_request", "Missing path");
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/workspace/file?path=${encodeURIComponent(path)}`,
    { sessionId, method: "DELETE" }
  );
  return relayJson(upstream);
}
