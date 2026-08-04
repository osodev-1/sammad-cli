import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, err } from "@/lib/http/envelope";
import { pollDevice } from "@/lib/auth/device";

const Body = z.object({
  deviceAuthId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be JSON");
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return err(400, "invalid_request", "Missing deviceAuthId");
  }

  const result = await pollDevice(parsed.data.deviceAuthId);

  if ("kind" in result) {
    if (result.kind === "expired") {
      return err(400, "device_code_expired", "The device code has expired — please run sanad login again");
    }
    if (result.kind === "denied") {
      return err(403, "authorization_denied", "The device request was denied");
    }
    if (result.kind === "not_found") {
      return err(404, "not_found", "Device auth request not found");
    }
  }

  return ok(result);
}
