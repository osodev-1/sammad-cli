import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getOrgUsage } from "@/lib/billing/quota";
import WorkspaceClient from "./WorkspaceClient";

export const metadata = { title: "sanad — workspace" };

export default async function TerminalPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  /*
   * Plan is fetched only to label the Nav chip (the dashboard does the same).
   * Workspace eligibility is decided by POST /api/terminal/session — the exact
   * call the WS handshake gates on — so page and socket can never disagree.
   */
  const usage = await getOrgUsage(`personal_${userId}`);

  return <WorkspaceClient plan={usage.plan} />;
}
