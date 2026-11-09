// publishConfig.exports (pointing at dist/) is applied only by pnpm. npm would publish exports that point at src/*.ts.
if (!/^pnpm\//.test(process.env.npm_config_user_agent ?? '')) {
  console.error('Pack and publish @camp-protocol/kit with pnpm (pnpm pack / pnpm publish), not npm.');
  process.exit(1);
}
