import { NextRequest } from "next/server";
import { ok, err } from "@/lib/http/envelope";
import { startDevice } from "@/lib/auth/device";

export async function POST(_req: NextRequest) {
  try {
    const result = await startDevice();
    return ok(result, 201);
  } catch (e) {
    console.error("device/start error", e);
    return err(500, "internal_error", "Failed to start device flow", true);
  }
}
