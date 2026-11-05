// Environment changes take effect on restart, just like the other .env settings.
// Preserve existing deployments when unset; explicit invalid values fail closed.
function isOnline(env = process.env) {
  const flags = [env.ONLINE, env.online].filter((value) => value !== undefined);
  return (
    flags.length === 0 ||
    flags.every((value) => String(value).trim().toLowerCase() === "true")
  );
}
module.exports = { isOnline };
