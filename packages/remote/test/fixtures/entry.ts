// Fixture: a thin-client script importing @ssf/remote (F-43).
// Bundled by the remote test to prove skill scripts can use the client.
import { createRemoteClient } from "@ssf/remote";

export async function run(): Promise<void> {
  const client = createRemoteClient({ endpoint: "https://licenses.example.com", getToken: () => "k" });
  console.log(JSON.stringify(await client.call("ping")));
}
