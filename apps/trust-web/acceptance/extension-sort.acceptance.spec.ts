import { test, expect } from "@playwright/test";

test("Kanban date sorting follows persisted timestamps and survives reload", async ({ page, request }) => {
  await request.post("/extensions/coordination/prepare", { data: {} });
  await request.post("/extensions/coordination/start", { data: {} });
  const missions: { mission: string; plan: string; owner: string | null; state: string; createdAt: string; updatedAt: string }[] = [];
  for (const offset of [0, 100]) {
    const response = await request.post("/extensions/coordination/commands", { data: { command: "missions.list", arguments: { limit: 100, offset } } });
    expect(response.ok()).toBe(true);
    missions.push(...(await response.json()).missions);
  }
  expect(missions.length).toBeGreaterThan(1);
  const { plans } = await (await request.get("/extensions/coordination/trust/plans")).json();
  const column = (mission: typeof missions[number]) => {
    const plan = plans.find((value: { plan: string }) => value.plan === mission.plan);
    if (!plan) return "unavailable";
    if (plan.workState === "COMPLETE") return "completed";
    if (plan.workState === "ESCALATED") return "blocked";
    return mission.state === "pending" && !mission.owner ? "pending" : "claimed";
  };
  await page.goto("/extensions/coordination");
  for (const sort of ["activity", "newest", "oldest"]) {
    await page.getByRole("combobox", { name: "Sort by", exact: true }).selectOption(sort);
    const field = sort === "activity" ? "updatedAt" : "createdAt";
    const ordered = [...missions].sort((a, b) => (Date.parse(a[field]) - Date.parse(b[field])) * (sort === "oldest" ? 1 : -1) || a.mission.localeCompare(b.mission));
    const expected = ["pending", "claimed", "blocked", "completed", "unavailable"].flatMap(state => ordered.filter(mission => column(mission) === state).map(mission => mission.mission));
    await expect.poll(() => page.locator("[data-mission]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-mission")))).toEqual(expected);
  }
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toHaveValue("oldest");
  await request.post("/extensions/coordination/stop", { data: {} });
});
