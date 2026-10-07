import { describe, expect, it } from "vitest";
import {
  asArray,
  asRecord,
  bool,
  clockTime,
  compact,
  count,
  dateOnly,
  durationMinutes,
  normalizeAppointment,
  normalizeAppointmentStatus,
  normalizeClient,
  normalizeClientDetail,
  normalizeConsent,
  normalizeDashboard,
  normalizeFollowUp,
  normalizeFollowUpStatus,
  normalizePriority,
  num,
  percent,
  pick,
  str,
  toList,
  unwrap,
} from "./normalize.js";

describe("primitive readers", () => {
  it("reads nested records and arrays without throwing on bad input", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
    expect(asArray([1])).toEqual([1]);
    expect(asArray("nope")).toEqual([]);
  });

  it("picks the first usable key", () => {
    expect(pick({ a: null, b: "", c: "value" }, "a", "b", "c")).toBe("");
    expect(pick({ a: null, b: undefined }, "a", "b")).toBeUndefined();
  });

  it("coerces numbers, counts and booleans", () => {
    expect(num("12")).toBe(12);
    expect(num("82%")).toBe(82);
    expect(num(undefined, 7)).toBe(7);
    expect(count([1, 2, 3])).toBe(3);
    expect(count("4")).toBe(4);
    expect(bool("yes")).toBe(true);
    expect(bool("declined")).toBe(false);
    expect(bool(undefined, true)).toBe(true);
    expect(str(12)).toBe("12");
    expect(str(null, "fallback")).toBe("fallback");
  });

  it("normalises rates expressed as fractions, numbers or percentages", () => {
    expect(percent(0.82)).toBe(82);
    expect(percent(82)).toBe(82);
    expect(percent("82%")).toBe(82);
    expect(percent(1)).toBe(100);
    expect(percent(0)).toBe(0);
    expect(percent(null, 42)).toBe(42);
    expect(percent(140)).toBe(100);
  });

  it("reads clinic clock times from bare and timestamp values", () => {
    expect(clockTime("9:05")).toBe("09:05");
    expect(clockTime("2026-10-07T14:30:00.000Z")).toBe("14:30");
    expect(clockTime("nope")).toBe("");
  });

  it("reads calendar days from day and timestamp values", () => {
    expect(dateOnly("2026-10-07")).toBe("2026-10-07");
    expect(dateOnly("2026-10-07T14:30:00.000Z")).toBe("2026-10-07");
    expect(dateOnly("")).toBe("");
    expect(durationMinutes("09:00", "09:30")).toBe(30);
    expect(durationMinutes("09:30", "09:00")).toBeNull();
  });

  it("unwraps envelopes and collections", () => {
    expect(unwrap({ data: { id: "1" } }, "dashboard")).toEqual({ id: "1" });
    expect(unwrap({ dashboard: { id: "2" } }, "dashboard")).toEqual({
      id: "2",
    });
    expect(toList({ clients: [{ id: "a" }] }, "clients")).toHaveLength(1);
    expect(toList({ items: [1, 2] })).toHaveLength(2);
    expect(toList({ nope: true })).toEqual([]);
  });

  it("drops empty request fields", () => {
    expect(compact({ a: " 1 ", b: "", c: null, d: undefined, e: 0 })).toEqual({
      a: "1",
      e: 0,
    });
  });
});

describe("status vocabulary", () => {
  it("maps server variants onto the known appointment statuses", () => {
    expect(normalizeAppointmentStatus("Checked-In")).toBe("checked_in");
    expect(normalizeAppointmentStatus("NO SHOW")).toBe("no_show");
    expect(normalizeAppointmentStatus("booked")).toBe("scheduled");
    expect(normalizeAppointmentStatus("in orbit")).toBe("unknown");
  });

  it("maps follow-up statuses and priorities", () => {
    expect(normalizeFollowUpStatus("in progress")).toBe("in_progress");
    expect(normalizeFollowUpStatus("Closed")).toBe("done");
    expect(normalizeFollowUpStatus("weird")).toBe("unknown");
    expect(normalizePriority("URGENT")).toBe("high");
    expect(normalizePriority("")).toBe("unknown");
  });
});

describe("entity normalisation", () => {
  it("normalises an appointment with nested client and provider objects", () => {
    const appointment = normalizeAppointment({
      id: "apt-1",
      client: { id: "cli-1", firstName: "Ada", lastName: "Lovelace" },
      provider: { id: "prov-1", firstName: "Grace", lastName: "Hopper" },
      date: "2026-10-07",
      startTime: "09:00",
      endTime: "09:30",
      status: "confirmed",
      type: "Vaccination",
      location: "Room 2",
    });
    expect(appointment.clientName).toBe("Ada Lovelace");
    expect(appointment.providerName).toBe("Grace Hopper");
    expect(appointment.status).toBe("confirmed");
    expect(appointment.rawStatus).toBe("confirmed");
    expect(appointment.location).toBe("Room 2");
  });

  it("derives an end time from a duration and keeps an unfamiliar status raw", () => {
    const appointment = normalizeAppointment({
      id: "apt-2",
      clientName: "Sam Reed",
      startTime: "11:00",
      durationMinutes: 45,
      status: "awaiting triage",
    });
    expect(appointment.endTime).toBe("11:45");
    expect(appointment.status).toBe("unknown");
    expect(appointment.rawStatus).toBe("awaiting triage");
  });

  it("reads consent from flags, nested objects and labels", () => {
    expect(normalizeConsent({ consentGranted: true }).granted).toBe(true);
    expect(normalizeConsent({ consent: false }).granted).toBe(false);
    const nested = normalizeConsent({
      consent: { status: "granted", date: "2026-09-01" },
    });
    expect(nested.granted).toBe(true);
    expect(nested.label).toBe("granted");
    expect(nested.date).toBe("2026-09-01");
  });

  it("assembles a client name from the available fields", () => {
    expect(
      normalizeClient({ firstName: "Ada", lastName: "Lovelace" }).fullName,
    ).toBe("Ada Lovelace");
    expect(normalizeClient({ name: "Sam Reed" }).fullName).toBe("Sam Reed");
    expect(normalizeClient({ firstName: "Ada" }).lastName).toBe("");
    expect(normalizeClient({}).fullName).toBe("Unnamed client");
  });

  it("normalises the client detail collections", () => {
    const detail = normalizeClientDetail({
      id: "cli-1",
      fullName: "Ada Lovelace",
      appointments: [{ id: "apt-1", date: "2026-10-07", status: "completed" }],
      followUps: [
        { id: "fu-1", title: "Call back", status: "open", priority: "high" },
      ],
      activity: [
        { id: "act-1", summary: "Client created", at: "2026-10-01T09:00:00Z" },
      ],
    });
    expect(detail.appointments).toHaveLength(1);
    expect(detail.followUps[0].priority).toBe("high");
    expect(detail.activity[0].summary).toBe("Client created");
  });

  it("normalises a follow-up with a due date and assignee", () => {
    const followUp = normalizeFollowUp({
      id: "fu-2",
      clientName: "Sam Reed",
      title: "Review blood pressure",
      priority: "medium",
      status: "in_progress",
      dueDate: "2026-10-09",
      owner: "Nurse Ada",
    });
    expect(followUp.dueDate).toBe("2026-10-09");
    expect(followUp.assignee).toBe("Nurse Ada");
    expect(followUp.status).toBe("in_progress");
  });
});

describe("dashboard normalisation", () => {
  it("reads metrics, lists and clinic context out of an envelope", () => {
    const dashboard = normalizeDashboard({
      data: {
        date: "2026-10-07",
        clinic: { name: "Riverside Pop-up", site: "Riverside Hall" },
        metrics: {
          todayAppointments: 12,
          booked: 9,
          capacity: 12,
          completionRate: 0.75,
          openFollowUps: 4,
          overdueFollowUps: 2,
          activeClients: 130,
        },
        upcomingAppointments: [
          {
            id: "apt-1",
            clientName: "Ada",
            startTime: "09:00",
            status: "scheduled",
          },
        ],
        sessionCapacity: [
          {
            label: "Morning",
            startTime: "09:00",
            endTime: "12:00",
            booked: 9,
            capacity: 12,
          },
        ],
        followUpPreview: [
          {
            id: "fu-1",
            title: "Call back",
            status: "open",
            dueDate: "2026-10-06",
          },
        ],
      },
    });
    expect(dashboard.clinicName).toBe("Riverside Pop-up");
    expect(dashboard.site).toBe("Riverside Hall");
    expect(dashboard.metrics.appointmentsToday).toBe(12);
    expect(dashboard.metrics.completionRate).toBe(75);
    expect(dashboard.upcoming).toHaveLength(1);
    expect(dashboard.sessions[0].booked).toBe(9);
    expect(dashboard.followUps).toHaveLength(1);
  });

  it("falls back to a single capacity bar and sensible defaults for sparse payloads", () => {
    const dashboard = normalizeDashboard({ capacity: 10, booked: 4 });
    expect(dashboard.clinicName).toBe("Caregrid Community Clinic");
    expect(dashboard.sessions).toHaveLength(1);
    expect(dashboard.sessions[0]).toMatchObject({
      booked: 4,
      capacity: 10,
      label: "Today's clinic",
    });
    expect(dashboard.upcoming).toEqual([]);
    expect(dashboard.metrics.completionRate).toBe(0);
  });

  it("never throws on a completely empty payload", () => {
    const dashboard = normalizeDashboard(null);
    expect(dashboard.metrics.appointmentsToday).toBe(0);
    expect(dashboard.sessions).toEqual([]);
    expect(dashboard.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
