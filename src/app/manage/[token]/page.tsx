import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ManageBooking from "@/components/meet/ManageBooking";
import MeetShell from "@/components/meet/MeetShell";
import { toBookingView } from "@/lib/meet/bookings";
import { getMeetConfig } from "@/lib/meet/config";
import { getMeetStore } from "@/lib/meet/store";
import { teamMeetingTypes } from "@/lib/meet/meetingTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manage links are private, token-addressed pages; keep them out of search.
export const metadata: Metadata = {
  title: "Manage booking",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const booking = await getMeetStore().getBookingByToken(token);
  if (!booking) notFound();
  const config = getMeetConfig();
  const view = toBookingView(booking);
  const enabled = teamMeetingTypes(config).some(({ key }) => key === view.meetingType);
  const rebookHref = view.pageKey ? `/${view.pageKey}` : enabled ? `/book/${view.meetingType}` : "/";
  return (
    <MeetShell homeHref="/">
      <div className="mx-auto w-full max-w-5xl flex-1 px-5 pt-6 pb-16 sm:px-6 sm:pt-10">
        <ManageBooking
          initial={view}
          hostTimezone={config.hostTimezone}
          initialDate={view.meetingType === "investor" ? config.investor?.startDate : undefined}
          canReschedule={Boolean(view.pageKey || enabled)}
          rebookHref={rebookHref}
        />
      </div>
    </MeetShell>
  );
}
