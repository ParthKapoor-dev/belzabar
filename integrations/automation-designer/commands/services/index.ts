import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface ServicesArgs {
  internal: boolean;
  search?: string;
}

interface ServiceRow {
  uuid: string;
  name: string;
  label: string;
  internalService: boolean;
  aliasNames: string[];
}

interface ServicesData {
  total: number;
  filter: { internal: boolean; search: string | null };
  services: ServiceRow[];
}

export const args = defineArgs({
  command: "belz ad services",
  flags: {
    ...AD_COMMON_FLAGS,
    internal: { type: "boolean" },
    search: { type: "string" },
  },
});

const command: CommandModule<ServicesArgs, ServicesData> = {
  schema: "ad.services",
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "services");
    return { internal: flags.internal, search: flags.search };
  },
  async execute({ internal, search }) {
    const raw = (await adApi.listServices({ limit: 2000, offset: 0 })) as unknown;
    const result = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as any)?.result)
        ? (raw as any).result
        : [];

    const services: ServiceRow[] = [];
    for (const item of result) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      services.push({
        uuid: typeof r.uuid === "string" ? r.uuid : "",
        name: typeof r.name === "string" ? r.name : "",
        label: typeof r.label === "string" ? (r.label as string) : "",
        internalService: r.internalService === true,
        aliasNames: Array.isArray(r.aliasName)
          ? (r.aliasName as unknown[]).filter((a): a is string => typeof a === "string")
          : [],
      });
    }

    let filtered = services;
    if (internal) filtered = filtered.filter(s => s.internalService);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.aliasNames.some(a => a.toLowerCase().includes(q)),
      );
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));

    return ok<ServicesData>({
      total: filtered.length,
      filter: { internal, search: search ?? null },
      services: filtered,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ServicesData;
    ui.section(`Services (${data.total})`);
    if (data.services.length === 0) ui.text("(none)");
    else ui.table(
      ["Name", "Label", "Internal", "Alias(es)"],
      data.services.map(s => [s.name, s.label, s.internalService ? "Yes" : "No", s.aliasNames.join(", ")]),
    );
  },
};

export default command;
