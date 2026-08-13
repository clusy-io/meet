import type { Metadata } from "next";
import { AdminPanel } from "@/components/meet/AdminPanel";

export const metadata: Metadata = {
  title: "Meet admin",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MeetAdminPage() {
  return <AdminPanel />;
}
