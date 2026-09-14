import type { TemplateService } from "../template/service.js";

const methods = ["template.list", "template.read", "template.save", "template.remove", "template.render"] as const;
type TemplateMethod = (typeof methods)[number];
export function isTemplateRpcMethod(value: string): value is TemplateMethod {
  return (methods as readonly string[]).includes(value);
}
export function executeTemplateRpc(
  method: TemplateMethod,
  params: unknown,
  service: TemplateService,
): Promise<unknown> {
  switch (method) {
    case "template.list":
      return service.list(params);
    case "template.read":
      return service.read(params);
    case "template.save":
      return service.save(params);
    case "template.remove":
      return service.remove(params);
    case "template.render":
      return service.render(params);
  }
}
