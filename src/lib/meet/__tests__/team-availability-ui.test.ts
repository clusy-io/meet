import { describe, expect, it } from "vitest";
import {
  addCivilDays,
  availabilitySlotsForDates,
  bestAvailabilityWindows,
  busyRangesForDay,
  freeRangesForMember,
  groupAvailabilitySlots,
  startOfIsoWeek,
} from "../../../components/meet/admin/teamAvailability";
import type { TeamAvailabilityResponse } from "../../../components/meet/admin/types";

function eligibleStarts(fromHour = 9, toHour = 13): string[] {
  const starts: string[] = [];
  for (let minute = fromHour * 60; minute + 30 <= toHour * 60; minute += 30) {
    const hour = String(Math.floor(minute / 60)).padStart(2, "0");
    const part = String(minute % 60).padStart(2, "0");
    starts.push(`2026-09-01T${hour}:${part}:00.000Z`);
  }
  return starts;
}

function serverSlot(hour: number, minute: number, freeMemberKeys: string[]) {
  const startMs = Date.UTC(2026, 8, 1, hour, minute);
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + 30 * 60_000).toISOString(),
    freeMemberKeys,
  };
}

function response(
  patch: Partial<TeamAvailabilityResponse> = {},
): TeamAvailabilityResponse {
  return {
    hostTimezone: "UTC",
    generatedAt: "2026-09-01T08:00:00.000Z",
    range: { from: "2026-08-31", to: "2026-09-07" },
    window: { start: "09:00", end: "13:00" },
    durationMinutes: 30,
    slotStepMinutes: 30,
    minNoticeMinutes: 0,
    quorum: 2,
    bookableWeekdays: [1, 2, 3, 4, 5],
    bookableDates: ["2026-09-01"],
    members: [
      {
        key: "ju",
        name: "Ju",
        status: "ready",
        eligibleStarts: eligibleStarts(),
        working: [
          {
            startAt: "2026-09-01T09:00:00.000Z",
            endAt: "2026-09-01T13:00:00.000Z",
          },
        ],
        busy: [
          {
            startAt: "2026-09-01T10:00:00.000Z",
            endAt: "2026-09-01T11:00:00.000Z",
          },
        ],
      },
      {
        key: "eldar",
        name: "Eldar",
        status: "ready",
        eligibleStarts: eligibleStarts(),
        working: [
          {
            startAt: "2026-09-01T09:00:00.000Z",
            endAt: "2026-09-01T13:00:00.000Z",
          },
        ],
        busy: [
          {
            startAt: "2026-09-01T11:00:00.000Z",
            endAt: "2026-09-01T12:00:00.000Z",
          },
        ],
      },
      {
        key: "fouzil",
        name: "Fouzil",
        status: "unavailable",
        busy: [],
        working: [],
        eligibleStarts: [],
      },
    ],
    slots: [
      serverSlot(9, 0, ["ju", "eldar"]),
      serverSlot(9, 30, ["ju", "eldar"]),
      serverSlot(12, 0, ["ju", "eldar"]),
      serverSlot(12, 30, ["ju", "eldar"]),
    ],
    ...patch,
  };
}

describe("team availability calendar projection", () => {
  it("moves through civil dates without leaking the machine timezone", () => {
    expect(addCivilDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(startOfIsoWeek("2026-09-06")).toBe("2026-08-31");
  });

  it("clips, joins, and projects cross-midnight busy intervals", () => {
    const busy = busyRangesForDay(
      [
        {
          startAt: "2026-08-31T23:30:00.000Z",
          endAt: "2026-09-01T09:30:00.000Z",
        },
        {
          startAt: "2026-09-01T09:20:00.000Z",
          endAt: "2026-09-01T10:00:00.000Z",
        },
        {
          startAt: "2026-09-01T18:00:00.000Z",
          endAt: "2026-09-01T19:00:00.000Z",
        },
      ],
      "2026-09-01",
      "UTC",
      9 * 60,
      17 * 60,
    );

    expect(busy).toEqual([{ start: 9 * 60, end: 10 * 60 }]);
  });

  it("never counts an unreadable member as free", () => {
    const data = response();
    const slots = availabilitySlotsForDates(data, ["2026-09-01"]);
    const atNine = slots.find((slot) => slot.start === 9 * 60);
    const atTen = slots.find((slot) => slot.start === 10 * 60);

    expect(atNine?.freeMemberKeys).toEqual(["ju", "eldar"]);
    expect(atTen).toBeUndefined();
    expect(freeRangesForMember(data.members[2], "2026-09-01", data)).toEqual(
      [],
    );
  });

  it("requires each member's own working grid before counting them free", () => {
    const data = response({
      members: [
        {
          key: "london",
          name: "London",
          status: "ready",
          busy: [],
          working: [
            {
              startAt: "2026-09-01T09:00:00.000Z",
              endAt: "2026-09-01T13:00:00.000Z",
            },
          ],
          eligibleStarts: eligibleStarts(9, 13),
        },
        {
          key: "baku",
          name: "Baku",
          status: "ready",
          busy: [],
          working: [
            {
              startAt: "2026-09-01T09:00:00.000Z",
              endAt: "2026-09-01T09:30:00.000Z",
            },
          ],
          eligibleStarts: ["2026-09-01T09:00:00.000Z"],
        },
      ],
      slots: [serverSlot(9, 0, ["london", "baku"])],
    });

    const slots = availabilitySlotsForDates(data, ["2026-09-01"]);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      start: 9 * 60,
      freeMemberKeys: ["london", "baku"],
    });
  });

  it("groups touching anchors into readable shared windows", () => {
    const windows = groupAvailabilitySlots([
      {
        dateKey: "2026-09-01",
        start: 9 * 60,
        end: 9 * 60 + 30,
        startAt: "2026-09-01T09:00:00.000Z",
        freeMemberKeys: ["ju", "eldar"],
      },
      {
        dateKey: "2026-09-01",
        start: 9 * 60 + 30,
        end: 10 * 60,
        startAt: "2026-09-01T09:30:00.000Z",
        freeMemberKeys: ["ju", "eldar"],
      },
    ]);

    expect(windows).toEqual([
      {
        dateKey: "2026-09-01",
        start: 9 * 60,
        end: 10 * 60,
        freeMemberKeys: ["ju", "eldar"],
      },
    ]);
  });

  it("ranks more people and then longer uninterrupted windows first", () => {
    const data = response({
      quorum: 1,
      members: [
        {
          key: "a",
          name: "A",
          status: "ready",
          busy: [],
          working: [
            {
              startAt: "2026-09-01T09:00:00.000Z",
              endAt: "2026-09-01T13:00:00.000Z",
            },
          ],
          eligibleStarts: eligibleStarts(),
        },
        {
          key: "b",
          name: "B",
          status: "ready",
          working: [
            {
              startAt: "2026-09-01T09:00:00.000Z",
              endAt: "2026-09-01T13:00:00.000Z",
            },
          ],
          eligibleStarts: eligibleStarts(),
          busy: [
            {
              startAt: "2026-09-01T09:00:00.000Z",
              endAt: "2026-09-01T10:00:00.000Z",
            },
          ],
        },
      ],
      slots: [
        serverSlot(9, 0, ["a"]),
        serverSlot(9, 30, ["a"]),
        ...[10, 10.5, 11, 11.5, 12, 12.5].map((hour) =>
          serverSlot(Math.floor(hour), (hour % 1) * 60, ["a", "b"]),
        ),
      ],
    });

    const best = bestAvailabilityWindows(data, ["2026-09-01"], 2);
    expect(best[0]?.freeMemberKeys).toEqual(["a", "b"]);
    expect(best[0]).toMatchObject({ start: 10 * 60, end: 13 * 60 });
    expect(best[1]?.freeMemberKeys).toEqual(["a"]);
  });
});
