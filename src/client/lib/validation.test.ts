import { describe, expect, it } from "vitest";
import {
  emptyAppointmentForm,
  emptyClientForm,
  emptyFollowUpForm,
  errorSummary,
  firstError,
  mapServerFieldErrors,
  validateAppointmentForm,
  validateClientForm,
  validateFollowUpForm,
} from "./validation.js";

describe("client intake validation", () => {
  it("accepts a complete intake", () => {
    const result = validateClientForm({
      ...emptyClientForm(),
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "555 0100",
      email: "ada@example.org",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("requires both names", () => {
    const result = validateClientForm(emptyClientForm());
    expect(result.valid).toBe(false);
    expect(result.errors.firstName).toBe("First name is required.");
    expect(result.errors.lastName).toBe("Last name is required.");
  });

  it("requires at least one way to reach the client", () => {
    const result = validateClientForm({
      ...emptyClientForm(),
      firstName: "Ada",
      lastName: "L",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.phone).toContain("phone number or an email");
  });

  it("rejects malformed contact details", () => {
    const result = validateClientForm({
      ...emptyClientForm(),
      firstName: "Ada",
      lastName: "L",
      email: "ada@example",
      phone: "12345",
    });
    expect(result.errors.email).toContain("name@example.org");
    expect(result.errors.phone).toContain("at least 7 digits");
  });

  it("accepts an email only intake and enforces the name length boundary", () => {
    expect(
      validateClientForm({
        ...emptyClientForm(),
        firstName: "Ada",
        lastName: "L",
        email: "a@b.co",
      }).valid,
    ).toBe(true);
    const boundary = validateClientForm({
      ...emptyClientForm(),
      firstName: "a".repeat(80),
      lastName: "L",
      email: "a@b.co",
    });
    expect(boundary.valid).toBe(true);
    const tooLong = validateClientForm({
      ...emptyClientForm(),
      firstName: "a".repeat(81),
      lastName: "L",
      email: "a@b.co",
    });
    expect(tooLong.errors.firstName).toContain("80 characters");
  });
});

describe("appointment validation", () => {
  it("accepts a complete booking", () => {
    const result = validateAppointmentForm({
      ...emptyAppointmentForm("2026-10-07"),
      clientId: "cli-1",
      providerId: "prov-1",
      startTime: "09:00",
      endTime: "09:30",
    });
    expect(result.valid).toBe(true);
  });

  it("requires a client, a provider and both times", () => {
    const result = validateAppointmentForm({
      ...emptyAppointmentForm("2026-10-07"),
      startTime: "",
      endTime: "",
    });
    expect(result.errors.clientId).toBe("Client is required.");
    expect(result.errors.providerId).toBe("Provider is required.");
    expect(result.errors.startTime).toBe("Start time is required.");
    expect(result.errors.endTime).toBe("End time is required.");
  });

  it("rejects an end time that is not after the start time", () => {
    const earlier = validateAppointmentForm({
      ...emptyAppointmentForm("2026-10-07"),
      clientId: "cli-1",
      providerId: "prov-1",
      startTime: "10:00",
      endTime: "09:30",
    });
    expect(earlier.errors.endTime).toBe(
      "The end time must be after the start time.",
    );
    const same = validateAppointmentForm({
      ...emptyAppointmentForm("2026-10-07"),
      clientId: "cli-1",
      providerId: "prov-1",
      startTime: "09:00",
      endTime: "09:00",
    });
    expect(same.valid).toBe(false);
  });

  it("rejects malformed dates and times", () => {
    const result = validateAppointmentForm({
      ...emptyAppointmentForm("07/10/2026"),
      clientId: "cli-1",
      providerId: "prov-1",
      startTime: "9am",
      endTime: "10:00",
    });
    expect(result.errors.date).toBe("Enter the date as YYYY-MM-DD.");
    expect(result.errors.startTime).toBe("Enter the start time as HH:MM.");
  });
});

describe("follow-up validation", () => {
  it("accepts a linked follow-up", () => {
    const result = validateFollowUpForm({
      ...emptyFollowUpForm("2026-10-09"),
      clientId: "cli-1",
      title: "Call to review results",
      priority: "high",
    });
    expect(result.valid).toBe(true);
  });

  it("requires a client and a task, and caps the title length", () => {
    const result = validateFollowUpForm(emptyFollowUpForm("2026-10-09"));
    expect(result.errors.clientId).toBe("Client is required.");
    expect(result.errors.title).toBe("Follow-up task is required.");
    const long = validateFollowUpForm({
      ...emptyFollowUpForm("2026-10-09"),
      clientId: "cli-1",
      title: "a".repeat(121),
    });
    expect(long.errors.title).toContain("120 characters");
  });

  it("rejects a malformed due date", () => {
    const result = validateFollowUpForm({
      ...emptyFollowUpForm("9 Oct"),
      clientId: "cli-1",
      title: "Call back",
    });
    expect(result.errors.dueDate).toBe("Enter the due date as YYYY-MM-DD.");
  });
});

describe("form error presentation", () => {
  it("maps snake_case server fields onto form fields", () => {
    expect(
      mapServerFieldErrors(
        { client_id: "Choose a client", start_time: "Slot is taken" },
        ["clientId", "startTime"],
      ),
    ).toEqual({ clientId: "Choose a client", startTime: "Slot is taken" });
  });

  it("keeps unknown server fields rather than dropping the message", () => {
    expect(
      mapServerFieldErrors({ capacity: "Session is full" }, ["clientId"]),
    ).toEqual({
      capacity: "Session is full",
    });
  });

  it("summarises single and multiple errors", () => {
    expect(errorSummary({})).toBe("");
    expect(errorSummary({ a: "Only problem" })).toBe("Only problem");
    expect(errorSummary({ a: "One", b: "Two" })).toBe(
      "2 fields need attention before this can be saved.",
    );
    expect(firstError({ b: "Second" })).toBe("Second");
  });
});
