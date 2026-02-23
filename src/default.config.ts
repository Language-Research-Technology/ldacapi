import packageJson from "../package.json" with { type: 'json' };
export default {
  package: packageJson,
  tokenAdmin: process.env.TOKEN_ADMIN || "1234-1234-1234-1234"
}