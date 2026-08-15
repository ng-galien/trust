import type {
  RegistryAuthority,
  RegistryAuthorizationRequest,
  RegistryPrincipal,
} from "../skill/authority.js";

export class LocalRegistryAuthority implements RegistryAuthority {
  authorize(request: RegistryAuthorizationRequest): RegistryPrincipal {
    if (request.anyRoleOf.length === 0) {
      throw new Error("Registry authorization requires at least one bounded role");
    }
    return {
      identity: request.assertedIdentity ?? `urn:trust:local:${request.anyRoleOf[0]}`,
      roles: request.anyRoleOf,
    };
  }
}
