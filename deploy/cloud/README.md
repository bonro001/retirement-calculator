# Cloud deploy — single-EC2 dispatcher + N hosts

This directory holds everything needed to run the policy-mining cluster on
one Ubuntu 24.04 EC2 instance fronted by Caddy + Let's Encrypt. Layout:

| File | What |
| --- | --- |
| `bootstrap.sh` | One-shot installer. Run on a fresh Ubuntu 24.04 EC2. Installs Node 22, Caddy, clones the repo, drops in systemd units, generates a token. |
| `cluster.env.example` | Environment file template. Copy to `/etc/default/cluster` and edit. |
| `Caddyfile` | TLS reverse proxy fronting the dispatcher on `localhost:8765`. |
| `systemd/cluster-dispatcher.service` | The dispatcher process. |
| `systemd/cluster-host@.service` | Templated host process. Enable as many as the box has cores for. |

## What the topology looks like once it's running

```
                         Internet
                            │
                       wss://mine.<ip>.sslip.io  (TLS via Let's Encrypt)
                            │
                          Caddy (:443)
                            │  reverse_proxy
                          ws://localhost:8765
                            │
                       Dispatcher (Node)
                            │  in-process WS
              ┌─────────────┼─────────────┐
        host@1            host@2       host@N
       (Node, 8 workers)   ...         ...
```

Browsers (and the controller CLI) talk to `wss://mine.<ip>.sslip.io` from
the public internet. Bearer-token auth (`CLUSTER_AUTH_TOKEN`) gates every
WS upgrade and every HTTP read endpoint except `/health`.

## Quick deploy

On the EC2 instance:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-fork>/retirement-calculator/main/deploy/cloud/bootstrap.sh | sudo bash -s -- mine.<ip>.sslip.io
```

(Or scp the `deploy/cloud` directory and run `sudo bash bootstrap.sh
mine.<ip>.sslip.io`.) The script prints a freshly generated token at the
end — set it in your local `.env`:

```
VITE_DISPATCHER_URL=wss://mine.<ip>.sslip.io
VITE_DISPATCHER_TOKEN=<generated-token>
```

Then `npm run build && npm run preview` (or your normal dev server) and
the browser will connect to the cloud dispatcher over wss.
