import { NextRequest } from "next/server";
import { z } from "zod";
import { err } from "@/lib/http/envelope";
import { verifyBearer } from "@/lib/auth/session";
import { revokeFamily } from "@/lib/tokens/runtime";

const Body = z.object({ familyId: z.string().min(1) });

export async function POST(req: NextRequest) {
  const session = await verifyBearer(req);
  if (!session) {
    return err(401, "unauthorized", "Invalid or revoked session token");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return err(400, "invalid_request", "Missing familyId");
  }

  await revokeFamily(session, parsed.data.familyId);

  return new Response(null, { status: 204 });
}
