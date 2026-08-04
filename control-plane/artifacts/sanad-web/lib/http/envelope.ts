import { NextResponse } from "next/server";

const rid = () => crypto.randomUUID();

export const ok = <T>(data: T, status = 200) =>
  NextResponse.json({ data, meta: { requestId: rid() } }, { status });

export const err = (
  status: number,
  code: string,
  message: string,
  retryable = false
) =>
  NextResponse.json(
    { error: { code, message, requestId: rid(), retryable } },
    { status }
  );
