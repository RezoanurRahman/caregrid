import { describe, expect, it } from "vitest";
import {
  appointmentActions,
  appointmentStatusLabel,
  appointmentStatusTone,
  deriveProviders,
  filterAppointments,
  filterClients,
  filterFollowUps,
  followUpActions,
  followUpDueText,
  followUpStatusLabel,
  isFollowUpOverdue,
  matchesClientSearch,
  priorityLabel,
  priorityTone,
  sortAppointments,
  sortFollowUps,
  upcomingAppointments,
} from "./status.js";
import type { Appointment, Client, FollowUp } from "../types.js";

const TODAY = "2026-10-07";

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "apt-1",
    clientId: "cli-1",
    clientName: "Ada Lovelace",
    providerId: "prov-1",
    providerName: "Dr Chen",
    date: TODAY,
    startTime: "09:00",
    endTime: "09:30",
    type: "Vaccination",
    reason: "",
    location: "Room 2",
    status: "scheduled",
    rawStatus: "scheduled",
    notes: "",
    ...overrides,
  };
}

function followUp(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: "fu-1",
    clientId: "cli-1",
    clientName: "Ada Lovelace",
    appointmentId: "",
    title: "Call back about results",
    detail: "",
    priority: "medium",
    rawPriority: "medium",
    status: "open",
    rawStatus: "open",
    dueDate: TODAY,
    assignee: "Nurse Ada",
    createdAt: "2026-10-01T09:00:00Z",
    completedAt: "",
    ...overrides,
  };
}

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: "cli-1",
    firstName: "Ada",
    lastName: "Lovelace",
    fullName: "Ada Lovelace",
    phone: "555 0100",
    email: "ada@example.org",
    preferredContact: "phone",
    status: "active",
    consent: { granted: true, label: "Consent recorded", date: "" },
    notes: "",
    since: "2026-01-04",
    language: "",
    ...overrides,
  };
}

describe("appointment status vocabulary", () => {
  it("labels known statuses and falls back to the raw server value", () => {
    expect(appointmentStatusLabel("checked_in")).toBe("Checked in");
    expect(appointmentStatusLabel("unknown", "awaiting triage")).toBe(
      "awaiting triage",
    );
    expect(appointmentStatusLabel("unknown")).toBe("Unrecognised");
    expect(appointmentStatusTone("completed")).toBe("success");
    expect(appointmentStatusTone("no_show")).toBe("warning");
  });

  it("offers only valid transitions per status", () => {
    expect(
      appointmentActions("scheduled").map((action) => action.status),
    ).toEqual(["confirmed", "checked_in", "no_show", "cancelled"]);
    expect(
      appointmentActions("confirmed").map((action) => action.status),
    ).toEqual(["checked_in", "no_show", "cancelled"]);
    expect(
      appointmentActions("checked_in").map((action) => action.status),
    ).toEqual(["completed"]);
    expect(appointmentActions("completed")).toEqual([]);
    expect(appointmentActions("no_show")).toEqual([]);
    expect(appointmentActions("cancelled")).toEqual([]);
    expect(appointmentActions("unknown")).toEqual([]);
  });
});

describe("follow-up status vocabulary", () => {
  it("labels statuses and priorities", () => {
    expect(followUpStatusLabel("in_progress")).toBe("In progress");
    expect(followUpStatusLabel("unknown", "escalated")).toBe("escalated");
    expect(priorityLabel("high")).toBe("High priority");
    expect(priorityTone("high")).toBe("danger");
    expect(priorityTone("low")).toBe("neutral");
  });

  it("offers only valid transitions per status", () => {
    expect(followUpActions("open").map((action) => action.status)).toEqual([
      "in_progress",
      "done",
    ]);
    expect(
      followUpActions("in_progress").map((action) => action.status),
    ).toEqual(["done"]);
    expect(followUpActions("done")).toEqual([]);
    expect(followUpActions("cancelled")).toEqual([]);
    expect(followUpActions("unknown")).toEqual([]);
  });

  it("treats only past, unfinished work as overdue", () => {
    expect(isFollowUpOverdue(followUp({ dueDate: "2026-10-06" }), TODAY)).toBe(
      true,
    );
    expect(isFollowUpOverdue(followUp({ dueDate: TODAY }), TODAY)).toBe(false);
    expect(isFollowUpOverdue(followUp({ dueDate: "2026-10-09" }), TODAY)).toBe(
      false,
    );
    expect(isFollowUpOverdue(followUp({ dueDate: "" }), TODAY)).toBe(false);
    expect(
      isFollowUpOverdue(
        followUp({ dueDate: "2026-10-01", status: "done" }),
        TODAY,
      ),
    ).toBe(false);
    expect(
      isFollowUpOverdue(
        followUp({ dueDate: "2026-10-01", status: "cancelled" }),
        TODAY,
      ),
    ).toBe(false);
  });

  it("never calls finished work late", () => {
    expect(followUpDueText(followUp({ dueDate: "2026-10-06" }), TODAY)).toBe(
      "1 day overdue",
    );
    expect(followUpDueText(followUp({ dueDate: "2026-10-04" }), TODAY)).toBe(
      "3 days overdue",
    );
    expect(followUpDueText(followUp({ dueDate: TODAY }), TODAY)).toBe(
      "Due today",
    );
    expect(followUpDueText(followUp({ dueDate: "2026-10-09" }), TODAY)).toBe(
      "Due in 2 days",
    );
    expect(
      followUpDueText(
        followUp({ dueDate: "2026-09-30", status: "done" }),
        TODAY,
      ),
    ).toBe("Was due Wed, Sep 30");
    expect(
      followUpDueText(
        followUp({ dueDate: "2026-09-30", status: "cancelled" }),
        TODAY,
      ),
    ).toBe("Was due Wed, Sep 30");
    expect(followUpDueText(followUp({ dueDate: "" }), TODAY)).toBe(
      "No due date",
    );
    expect(
      followUpDueText(followUp({ dueDate: "", status: "done" }), TODAY),
    ).toBe("No due date");
  });

  it("filters by open, in progress, done and overdue", () => {
    const items = [
      followUp({ id: "a", status: "open", dueDate: "2026-10-01" }),
      followUp({ id: "b", status: "in_progress", dueDate: "2026-10-09" }),
      followUp({ id: "c", status: "done", dueDate: "2026-10-02" }),
      followUp({ id: "d", status: "open", dueDate: "2026-10-20" }),
    ];
    expect(filterFollowUps(items, "all", TODAY)).toHaveLength(4);
    expect(
      filterFollowUps(items, "open", TODAY).map((item) => item.id),
    ).toEqual(["a", "d"]);
    expect(
      filterFollowUps(items, "in_progress", TODAY).map((item) => item.id),
    ).toEqual(["b"]);
    expect(
      filterFollowUps(items, "done", TODAY).map((item) => item.id),
    ).toEqual(["c"]);
    expect(
      filterFollowUps(items, "overdue", TODAY).map((item) => item.id),
    ).toEqual(["a"]);
  });

  it("sorts overdue work first, then due date, then priority", () => {
    const sorted = sortFollowUps(
      [
        followUp({ id: "later", dueDate: "2026-10-12", priority: "high" }),
        followUp({ id: "overdue-low", dueDate: "2026-10-05", priority: "low" }),
        followUp({ id: "today-high", dueDate: TODAY, priority: "high" }),
        followUp({ id: "no-due", dueDate: "", priority: "medium" }),
      ],
      TODAY,
    );
    expect(sorted.map((item) => item.id)).toEqual([
      "overdue-low",
      "today-high",
      "later",
      "no-due",
    ]);
  });
});

describe("list filtering", () => {
  it("matches appointments against the chosen filters", () => {
    const items = [
      appointment({
        id: "a",
        date: TODAY,
        status: "scheduled",
        providerId: "prov-1",
      }),
      appointment({
        id: "b",
        date: "2026-10-08",
        status: "confirmed",
        providerId: "prov-2",
      }),
    ];
    expect(filterAppointments(items, {}).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      filterAppointments(items, { date: TODAY }).map((item) => item.id),
    ).toEqual(["a"]);
    expect(
      filterAppointments(items, { status: "confirmed" }).map((item) => item.id),
    ).toEqual(["b"]);
    expect(
      filterAppointments(items, { providerId: "prov-2" }).map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterAppointments(items, { date: TODAY, status: "confirmed" }),
    ).toEqual([]);
  });

  it("sorts and limits upcoming appointments", () => {
    const sorted = sortAppointments([
      appointment({ id: "late", date: TODAY, startTime: "15:00" }),
      appointment({ id: "past", date: "2026-10-01", startTime: "09:00" }),
      appointment({ id: "early", date: TODAY, startTime: "08:30" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["past", "early", "late"]);
    expect(upcomingAppointments(sorted, TODAY).map((item) => item.id)).toEqual([
      "early",
      "late",
    ]);
  });

  it("searches clients by name, phone and email, case insensitively", () => {
    expect(matchesClientSearch(client(), "ADA")).toBe(true);
    expect(matchesClientSearch(client(), "555 0100")).toBe(true);
    expect(matchesClientSearch(client(), "example.org")).toBe(true);
    expect(matchesClientSearch(client(), "   ")).toBe(true);
    expect(matchesClientSearch(client(), "grace")).toBe(false);
    expect(
      filterClients(
        [client(), client({ id: "cli-2", fullName: "Grace Hopper" })],
        "grace",
      ).map((c) => c.id),
    ).toEqual(["cli-2"]);
  });

  it("derives a provider directory from appointments without duplicates", () => {
    const providers = deriveProviders([
      appointment({ id: "a", providerId: "prov-2", providerName: "Dr Chen" }),
      appointment({ id: "b", providerId: "prov-1", providerName: "Dr Okafor" }),
      appointment({ id: "c", providerId: "prov-2", providerName: "Dr Chen" }),
      appointment({ id: "d", providerId: "", providerName: "" }),
    ]);
    expect(providers.map((provider) => provider.name)).toEqual([
      "Dr Chen",
      "Dr Okafor",
    ]);
  });
});
