# M7 — adapter standard and local team policy

## Product boundary

Fleet remains a local capability/configuration control plane. M7 does not add a
hosted policy service, organization account, approval workflow, agent runner, or
remote enforcement. It standardizes the in-process adapter boundary and lets an
administrator provision one strict local policy ceiling under Fleet's state
home.

## Adapter contract v1

External adapter modules declare `contractVersion: 1`. Before registration,
Fleet validates the structural adapter methods and the complete semantics of
each declared capability surface. In particular:

- unsupported inventory pairs only with `management: none`;
- delegated management is plugin-only and never invents a BYO vendor command;
- writable management is limited to MCP, skill, and rule surfaces and requires
  the matching pure render methods plus `supportsWrite: true`;
- unknown capability kinds, enum values, or surface fields reject the module;
- command/hook inventory cannot be declared supported until their core schemas exist;
- missing/unknown versions and malformed v1 contracts have separate Doctor
  findings.

The contract is compatibility validation, not a sandbox. Importing a configured
module executes trusted local code in the Fleet process. Deadlines prevent a
hung import/factory from blocking startup, but do not revoke code already run.

## Team policy v1

`$FLEET_HOME/team-policy.json` is opened as a pinned regular no-follow leaf. Its
allowlisted schema is:

```json
{
  "version": 1,
  "agents": ["claude-code", "codex"],
  "feedSources": ["mcp-registry"],
  "trustPolicy": "block",
  "allowAdapterModules": false
}
```

Fields other than `version` are optional. `null` list values mean no team
ceiling; an empty list means none. A present policy defaults
`allowAdapterModules` to false unless it explicitly opts in. Effective lists
are intersections with user config, and `block` wins over `warn`, including a
per-plan override.

Missing policy means no team ceiling. Invalid syntax/schema, unreadable state,
wrong type, or a symlink is never treated as missing: read-only startup uses an
empty adapter/feed/module set with block trust, and mutation preflight refuses
to proceed. Doctor and the local config command expose only stable status/codes
and the effective, secret-safe configuration.

Long-running MCP/Web processes load adapter modules once. Policy or adapter-list
changes therefore require a process restart; commit still rechecks policy
readability and the team trust ceiling under the mutation lock.
