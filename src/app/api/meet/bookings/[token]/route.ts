import { NextResponse } from "next/server";
import { toBookingView } from "@/lib/meet/bookings";
import { listEffectiveMembers } from "@/lib/meet/members";
import { getMeetStore } from "@/lib/meet/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  try {
    const booking = await getMeetStore().getBookingByToken(token);
    if (!booking) {
      return NextResponse.json({ message: "Booking not found." }, { status: 404 });
    }
    return NextResponse.json({ booking: toBookingView(booking, await listEffectiveMembers()) });
  } catch (err) {
    console.error("meet: booking lookup failed", err);
    return NextResponse.json({ message: "Something went wrong. Try again." }, { status: 500 });
  }
}
