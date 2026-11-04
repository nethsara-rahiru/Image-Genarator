import { configuration } from "../src/config.js";
import {
  createClient,
  readClients,
  publicClient,
  revokeClient,
  rotateClient,
} from "../src/apiClients.js";
const [command, ...args] = process.argv.slice(2);
const config = configuration();
try {
  if (command === "create") {
    const name = args[0];
    const scopes = (args[1] || "read,generate").split(",");
    const result = await createClient(
      config.data,
      name,
      scopes,
      Number(args[2] || 90),
    );
    console.log(JSON.stringify(result, null, 2));
    console.error(
      "Save this token securely; it is shown only once. Never commit it or paste it into chat.",
    );
  } else if (command === "rotate") {
    console.log(
      JSON.stringify(
        await rotateClient(config.data, args[0], Number(args[1] || 90)),
        null,
        2,
      ),
    );
    console.error(
      "Save the new token securely; the previous token is now invalid.",
    );
  } else if (command === "list")
    console.log(
      JSON.stringify(
        (await readClients(config.data)).map(publicClient),
        null,
        2,
      ),
    );
  else if (command === "revoke")
    console.log(
      JSON.stringify(await revokeClient(config.data, args[0]), null, 2),
    );
  else
    throw new Error(
      'Usage: npm run api-client -- create "client name" [read,generate,browser] [expiry-days]\n       npm run api-client -- list\n       npm run api-client -- revoke <client-id>\n       npm run api-client -- rotate <client-id> [expiry-days]',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
