import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AvailabilityPrime } from "@/components/meet/AvailabilityPrime";
import MeetBooking from "@/components/meet/MeetBooking";
import MeetShell from "@/components/meet/MeetShell";
import { getMeetConfig } from "@/lib/meet/config";
import { teamMeetingTypes } from "@/lib/meet/meetingTypes";
import { SITE } from "@/meet.config";

export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ type: string }> };

async function bookingOption({ params }: RouteProps) {
  const { type } = await params;
  const config = getMeetConfig();
  const option = teamMeetingTypes(config).find(({ key }) => key === type);
  if (!option) notFound();
  return {
    ...option,
    initialDate: option.key === "investor" ? config.investor?.startDate : undefined,
  };
}

export async function generateMetadata(props: RouteProps): Promise<Metadata> {
  const option = await bookingOption(props);
  const title = `${option.label} · ${option.durationMinutes} min`;
  const url = `/book/${option.key}`;
  const description = option.description || SITE.description;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function TeamBookingPage(props: RouteProps) {
  const option = await bookingOption(props);
  return (
    <MeetShell prime={<AvailabilityPrime meetingType={option.key} />}>
      <div className="flex flex-1 justify-center px-5 pt-6 pb-16 sm:px-8 sm:pt-10">
        <MeetBooking
          key={option.key}
          headline={`${option.label} · ${option.durationMinutes} min`}
          meetingType={option.key}
          initialDate={option.initialDate}
          blurb={option.description}
        />
      </div>
    </MeetShell>
  );
}
