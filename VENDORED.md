# Vendored packages

This bundle ships two packages copied out of the running DeepSeek Harness install
(`resources/app.asar/dsh/node_modules/...`), because a linked plugin cannot resolve
them from the dsh installation and the npm registry is unreachable on this machine.

| Package | Version | License | Why |
|---|---|---|---|
| `@deepseek-ai/schemastery` | 3.19.0 | MIT | `export const Config` must be a native Schemastery schema for the Settings form; cordis also validates config through its `~standard` interface. |
| `@deepseek-ai/cosmokit` | (as shipped) | MIT | Runtime dependency of schemastery. |

Both are unmodified copies. After upgrading DeepSeek Harness, re-extract them from the
new install so versions stay aligned:

```
# app.asar/dsh/node_modules/@deepseek-ai/{schemastery,cosmokit}
```

`@standard-schema/spec` is a type-only dependency of schemastery and is not needed at runtime.
