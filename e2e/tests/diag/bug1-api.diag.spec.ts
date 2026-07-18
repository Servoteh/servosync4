import { test } from '@playwright/test';

// Decidna potvrda BUG1 root-cause-a bez krhke UI navigacije: pozovi profile/team i
// team/:id/tools iz autentikovanog konteksta i pogledaj OBLIK `data` na /tools.
test('DIAG BUG1 API shape: /profile/team/:id/tools = objekat {employeeId,tools}', async ({ page }) => {
  await page.goto('/profil', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const out = await page.evaluate(async () => {
    const token = localStorage.getItem('servosync.token');
    const base = 'https://api.servosync2.servoteh.com/api';
    const h = { Authorization: 'Bearer ' + token } as Record<string, string>;
    const teamRes = await fetch(base + '/v1/profile/team', { headers: h });
    const team = await teamRes.json().catch(() => null);
    const d = team?.data ?? {};
    const members = d.members ?? d.roster ?? d.team ?? (Array.isArray(d) ? d : []);
    const first = Array.isArray(members) ? members[0] : undefined;
    const id = first?.id ?? first?.employeeId ?? first?.employee_id;
    let toolsShape: unknown = null;
    if (id) {
      const tr = await fetch(base + '/v1/profile/team/' + id + '/tools', { headers: h });
      const tj = await tr.json().catch(() => null);
      const td = tj?.data;
      toolsShape = {
        httpStatus: tr.status,
        dataIsArray: Array.isArray(td),
        dataKeys: td && typeof td === 'object' && !Array.isArray(td) ? Object.keys(td) : null,
        toolsIsArray: Array.isArray((td as { tools?: unknown })?.tools),
      };
    }
    return {
      teamStatus: teamRes.status,
      teamDataKeys: Array.isArray(d) ? '(array)' : Object.keys(d),
      memberCount: Array.isArray(members) ? members.length : 0,
      pickedId: id ?? null,
      toolsShape,
    };
  });

  // eslint-disable-next-line no-console
  console.log('\n===== BUG1 API shape =====\n' + JSON.stringify(out, null, 2) + '\n');
});
