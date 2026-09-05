export function createExtension() {
  let missions;
  return {
    async prepare() {},
    async start() {},
    async stop() {},
    async read() {
      missions ??= [
        {
          mission: "federation-acceptance",
          plan: "interface-acceptance",
          project: "TRUST",
          assignee: "acceptance-agent",
          owner: "acceptance-agent",
          state: "completed",
          request: {
            instructions:
              "## Review the change\n\n- Read the **public result**.\n- Keep `Plan` state separate.\n\n[Reference](https://example.com)\n\n<script>window.extensionUnsafe=true</script>\n\n```mermaid\nflowchart LR\n  Mission --> Plan\n```",
            expected: "A readable **result**.",
            authorized: "1. Read the mission.\n2. Inspect its Plan.",
            forbidden: "Do not infer success.",
          },
          response: "### Delivered\n\nThe external work is complete.\n\n```mermaid\nthis is not a diagram\n```",
          tags: ["review"],
          tagRevision: 0,
          createdAt: "2026-09-05T08:00:00.000Z",
          updatedAt: "2026-09-05T09:00:00.000Z",
        },
      ];
      return {
        status: 200,
        body: {
          missions,
        },
      };
    },
    async command({ command, arguments: args }) {
      await this.read();
      if (missions.length === 1)
        missions.push(
          ...Array.from({ length: 105 }, (_, index) => ({
            ...missions[0],
            mission: `other-${index}`,
            plan: index === 1 ? "escalated-plan" : "other-plan",
            project: "Other",
            assignee: "other-agent",
            tags: ["other"],
            request: { instructions: `Other mission ${index}` },
          })),
          {
            ...missions[0],
            mission: "later-page",
            plan: "interface-acceptance",
            project: "Later",
            assignee: "later-agent",
            tags: ["later"],
            request: { instructions: "Later page mission" },
          },
        );
      if (command === "missions.suggest") {
        const matches = missions.filter(
          (item) =>
            (!args.project || item.project === args.project) &&
            (!args.assignee || item.assignee === args.assignee) &&
            (!args.tags || args.tags.every((tag) => item.tags.includes(tag))) &&
            (!args.search || JSON.stringify(item).toLowerCase().includes(args.search.toLowerCase())),
        );
        const values = [...new Set(matches.flatMap((item) => (args.field === "tags" ? item.tags : [item[args.field]])))]
          .filter((value) => value.toLowerCase().includes((args.query ?? "").toLowerCase()))
          .sort();
        const limit = args.limit ?? 10;
        return {
          status: 200,
          body: {
            field: args.field,
            query: args.query ?? "",
            values: values.slice(0, limit),
            hasMore: values.length > limit,
            limit,
          },
          text: `${values.length} distinct values`,
        };
      }
      if (command === "missions.list") {
        const matches = missions.filter(
          (item) =>
            (!args.project || item.project === args.project) &&
            (!args.assignee || item.assignee === args.assignee) &&
            (!args.tags || args.tags.every((tag) => item.tags.includes(tag))) &&
            (!args.search || JSON.stringify(item).toLowerCase().includes(args.search.toLowerCase())),
        );
        const offset = args.offset ?? 0,
          limit = args.limit ?? 50;
        return {
          status: 200,
          body: { missions: matches.slice(offset, offset + limit), total: matches.length, offset, limit },
          text: `${matches.length} missions`,
        };
      }
      if (command === "tags.replace") {
        const mission = missions.find((item) => item.mission === args.mission);
        if (!mission) return { status: 404, body: { error: "Unknown mission" }, text: "Unknown mission" };
        if (mission.tagRevision !== args.expectedRevision)
          return { status: 409, body: { error: "Tags changed" }, text: "Tags changed" };
        mission.tags = args.tags;
        mission.tagRevision++;
        return {
          status: 200,
          body: { mission: mission.mission, tags: mission.tags, tagRevision: mission.tagRevision },
          text: "Tags updated",
        };
      }
      return { status: 400, body: { error: "Unknown command" }, text: "Unknown command" };
    },
  };
}
