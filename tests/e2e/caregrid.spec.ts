import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Caregrid browser journeys.
 *
 * These tests drive the built application against its real Fastify + SQLite API. Nothing is
 * mocked: the deterministic seed (CAREGRID_TODAY=2026-10-07) provides the clinic day, and the
 * helpers below read the same API the browser talks to so conflicts and free slots are discovered
 * instead of guessed.
 */

const TODAY = '2026-10-07';
const CAPACITY_STATUSES = new Set(['requested', 'confirmed', 'checked_in', 'completed', 'no_show']);

/** The only appointment `type` values the API accepts; the form must submit one of these. */
const API_APPOINTMENT_TYPES: readonly string[] = [
  'intake',
  'check_in',
  'follow_up',
  'screening',
  'other',
];

interface ApiProvider {
  id: string;
  name: string;
  active: boolean;
}

interface ApiSession {
  id: string;
  date: string;
  opensAt: string;
  closesAt: string;
  capacity: number;
}

interface ApiAppointment {
  id: string;
  clientId: string;
  providerId: string;
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  clientName: string;
}

interface ApiClient {
  id: string;
  firstName: string;
  lastName: string;
}

function toMinutes(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function toTime(total: number): string {
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

function overlaps(
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
): boolean {
  return (
    toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime)
  );
}

async function fetchJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.ok(), `${url} should answer 2xx`).toBe(true);
  return (await response.json()) as T;
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${test
    .info()
    .project.name.replace(/[^a-z]/gi, '')
    .slice(0, 2)}`;
}

/** Reads the seeded conflict straight from the API: the first blocking appointment today. */
async function findSeededConflict(request: APIRequestContext): Promise<ApiAppointment> {
  const appointments = await fetchJson<ApiAppointment[]>(
    request,
    `/api/appointments?date=${TODAY}`,
  );
  const conflict = appointments.find((appointment) =>
    ['requested', 'confirmed', 'checked_in', 'completed'].includes(appointment.status),
  );
  if (!conflict) throw new Error('The seed does not contain a blocking appointment on 2026-10-07');
  return conflict;
}

/** Finds a session slot on 2026-10-07 that is genuinely free for a provider and has capacity. */
async function findFreeSlot(
  request: APIRequestContext,
): Promise<{ provider: ApiProvider; startTime: string; endTime: string }> {
  const providers = await fetchJson<ApiProvider[]>(request, '/api/providers');
  const sessions = await fetchJson<ApiSession[]>(request, `/api/sessions?date=${TODAY}`);
  const appointments = await fetchJson<ApiAppointment[]>(
    request,
    `/api/appointments?date=${TODAY}`,
  );

  for (const provider of providers.filter((candidate) => candidate.active)) {
    for (const session of sessions) {
      const booked = appointments.filter(
        (appointment) =>
          appointment.sessionId === session.id && CAPACITY_STATUSES.has(appointment.status),
      ).length;
      if (booked >= session.capacity) continue;
      const busy = appointments.filter(
        (appointment) =>
          appointment.providerId === provider.id && appointment.status !== 'cancelled',
      );
      for (
        let start = toMinutes(session.opensAt);
        start + 30 <= toMinutes(session.closesAt);
        start += 5
      ) {
        const candidate = {
          startTime: toTime(start),
          endTime: toTime(start + 30),
        };
        if (!busy.some((appointment) => overlaps(candidate, appointment))) {
          return { provider, ...candidate };
        }
      }
    }
  }
  throw new Error('The seed has no free provider slot on 2026-10-07');
}

async function createClientThroughUi(page: Page, lastName: string): Promise<string> {
  await page.getByTestId('new-client').click();
  const form = page.getByTestId('client-form');
  await expect(form).toBeVisible();
  await page.getByTestId('client-first-name').fill('Browser');
  await page.getByTestId('client-last-name').fill(lastName);
  await page.getByTestId('client-phone').fill('555-0134');
  await page.getByTestId('client-consent').check();

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/clients',
  );
  await page.getByTestId('client-submit').click();
  expect((await created).status()).toBe(201);

  await page.getByTestId('client-search').fill(lastName);
  const row = page.locator('[data-testid^="client-row-"]').filter({ hasText: lastName }).first();
  await expect(row).toBeVisible();
  const testId = await row.getAttribute('data-testid');
  const clientId = testId?.replace('client-row-', '') ?? '';
  expect(clientId).not.toBe('');
  const detail = page.getByTestId('client-detail');
  if (!(await detail.isVisible())) {
    // Creating a client already selects it; clicking is only needed when it is not open yet.
    await row.click();
  }
  await expect(detail).toContainText(lastName);
  await expect(detail).toContainText('555-0134');
  return clientId;
}

test.describe('journey A: conflict-aware booking', () => {
  test('books around a provider conflict and succeeds in a free slot', async ({
    page,
    request,
  }) => {
    const conflict = await findSeededConflict(request);
    const freeSlot = await findFreeSlot(request);

    const suffix = uniqueSuffix();
    const createClient = await request.post('/api/clients', {
      data: {
        firstName: 'Journey',
        lastName: `Slots${suffix}`,
        phone: '555-0155',
      },
    });
    expect(createClient.status()).toBe(201);
    const client = (await createClient.json()) as ApiClient;

    // Overview: real seeded metrics and content.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('metric-today-appointments')).toContainText(/\d/);
    await expect(page.getByTestId('metric-open-followups')).toContainText(/\d/);
    await expect(page.getByTestId('metric-booked-capacity')).toContainText(/\d/);
    await expect(page.getByTestId('overview-open-followups')).toBeVisible();
    expect(await page.locator('caregrid-appointment-summary').count()).toBeGreaterThan(0);
    const todayCount = Number(
      (await page.getByTestId('metric-today-appointments').innerText()).match(/\d+/)?.[0] ?? '0',
    );
    expect(todayCount).toBeGreaterThan(0);

    // Appointments: open the booking dialog.
    await page.getByTestId('nav-appointments').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toBeVisible();
    await page.getByTestId('new-appointment').click();
    const form = page.getByTestId('appointment-form');
    await expect(form).toBeVisible();

    // Deliberate conflict: same provider, date and time as a seeded appointment.
    await page.getByTestId('appointment-client').selectOption(client.id);
    await page.getByTestId('appointment-provider').selectOption(conflict.providerId);
    await page.getByTestId('appointment-date').fill(TODAY);
    await page.getByTestId('appointment-start').fill(conflict.startTime);
    await page.getByTestId('appointment-end').fill(conflict.endTime);
    await page.getByTestId('appointment-reason').fill('Deliberate conflict from the browser suite');

    const conflictingPost = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/appointments',
    );
    await page.getByTestId('appointment-submit').click();
    const refusal = await conflictingPost;
    const submitted = refusal.request().postDataJSON() as { type?: string };
    expect(
      API_APPOINTMENT_TYPES,
      `the booking form must submit an API appointment type, not a display label: got ${JSON.stringify(
        submitted.type,
      )}`,
    ).toContain(submitted.type);
    expect(
      refusal.status(),
      `booking a conflicting slot must answer 409, got ${refusal.status()}: ${await refusal.text()}`,
    ).toBe(409);

    const error = page.getByTestId('appointment-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText(
      /could not be booked|conflict|clash|already booked|overlaps/i,
    );
    // The dialog keeps the coordinator's values after the refusal.
    await expect(page.getByTestId('appointment-start')).toHaveValue(conflict.startTime);
    await expect(page.getByTestId('appointment-client')).toHaveValue(client.id);

    // Correct the times to a free slot and book for real.
    await page.getByTestId('appointment-provider').selectOption(freeSlot.provider.id);
    await page.getByTestId('appointment-start').fill(freeSlot.startTime);
    await page.getByTestId('appointment-end').fill(freeSlot.endTime);
    // The refusal stays on screen until the corrected form is submitted.
    await expect(error).toBeVisible();

    const successfulPost = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/appointments',
    );
    await page.getByTestId('appointment-submit').click();
    expect((await successfulPost).status()).toBe(201);

    await expect(page.getByTestId('appointment-form')).toBeHidden();
    await expect(page.getByTestId('toast-region')).toContainText(/booked/i);
    const bookedRow = page
      .locator('[data-testid^="appointment-row-"]')
      .filter({ hasText: `Slots${suffix}` })
      .first();
    await expect(bookedRow).toBeVisible();
    await expect(bookedRow).toContainText(freeSlot.startTime);
  });

  test('closes the booking dialog with Escape without booking', async ({ page }) => {
    let bookingAttempts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/appointments') {
        bookingAttempts += 1;
      }
    });

    await page.goto('/');
    await page.getByTestId('nav-appointments').click();
    await page.getByTestId('new-appointment').click();
    await expect(page.getByTestId('appointment-form')).toBeVisible();

    // Opening the modal moves focus inside it, so Escape is handled by the dialog instead of
    // being swallowed by the page. Waiting for that focus keeps the test deterministic.
    const closeButton = page.locator('caregrid-dialog').getByRole('button', { name: 'Close' });
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('appointment-form')).toBeHidden();
    // Focus returns to the trigger so keyboard users keep their place.
    await expect(page.getByTestId('new-appointment')).toBeFocused();
    expect(bookingAttempts).toBe(0);
  });
});

test.describe('journey B: intake and follow-up work', () => {
  test('registers a client, opens their record and completes a follow-up', async ({ page }) => {
    const suffix = uniqueSuffix();
    const lastName = `Desk${suffix}`;
    const title = `Arrange transport for ${lastName}`;

    await page.goto('/');
    await page.getByTestId('nav-clients').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible();

    const clientId = await createClientThroughUi(page, lastName);

    // The follow-up queue picks up the new client and works the full lifecycle.
    await page.getByTestId('nav-followups').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();
    const followUpForm = page.getByTestId('followup-form');
    await expect(followUpForm).toBeVisible();
    await page.getByTestId('followup-client').selectOption(clientId);
    await page.getByTestId('followup-title').fill(title);
    await page.getByTestId('followup-due').fill('2026-10-09');
    await page.getByTestId('followup-priority').selectOption('high');

    const createdFollowUp = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.startsWith('/api/follow'),
    );
    await page.getByTestId('followup-submit').click();
    expect((await createdFollowUp).status()).toBe(201);

    const row = page.locator('[data-testid^="followup-row-"]').filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(lastName);
    await expect(row.getByText('Open', { exact: true })).toBeVisible();

    const started = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/api/followups/'),
    );
    await row.getByTestId('followup-action-in_progress').click();
    expect((await started).status()).toBe(200);
    await expect(row.getByText('In progress', { exact: true })).toBeVisible();

    const completed = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/api/followups/'),
    );
    await row.getByTestId('followup-action-done').click();
    expect((await completed).status()).toBe(200);
    await expect(row.getByText('Done', { exact: true })).toBeVisible();

    // The server agrees: the follow-up is done and belongs to the new client.
    const followUps = await fetchJson<Array<{ clientId: string; title: string; status: string }>>(
      page.request,
      `/api/follow-ups?clientId=${encodeURIComponent(clientId)}`,
    );
    const stored = followUps.find((followUp) => followUp.title === title);
    expect(stored?.status).toBe('done');
  });
});

test.describe('responsive shell', () => {
  test('keeps the primary navigation usable and the content inside the viewport', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    const views: Array<[string, string]> = [
      ['nav-appointments', 'Appointments'],
      ['nav-clients', 'Clients'],
      ['nav-followups', 'Follow-ups'],
      ['nav-overview', 'Overview'],
    ];
    for (const [testId, heading] of views) {
      const navButton = page.getByTestId(testId);
      await expect(navButton).toBeVisible();
      await navButton.click();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      const fits = await page.evaluate(() => {
        const main = document.querySelector('main');
        if (main === null) return false;
        const rect = main.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= window.innerWidth + 1;
      });
      expect(fits, `${heading} should fit the ${test.info().project.name} viewport`).toBe(true);
    }
  });
});
