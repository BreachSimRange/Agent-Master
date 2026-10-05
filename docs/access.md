[← back to the README](../README.md)

# Access the UI safely

The three supported ways to reach Agent-Master from another device, and why there is no fourth.

> **Never expose Agent-Master directly to the internet.** A signed-in operator has a shell, an editor
> and every agent on the machine, so the account password would be the only thing between the
> internet and your computer. No router port forwarding, no public reverse proxy, no Tailscale Funnel
> or Cloudflare Tunnel, no `--host 0.0.0.0` on a machine with a public address.
>
> **Recommended: a private network you control, plus the root certificate on every device.** Put the
> machine and your devices on a tailnet (Tailscale) or your own WireGuard VPN, serve HTTPS with the
> certificate from `make-cert.sh`, and install its root certificate on each phone, tablet and laptop
> that will use the UI. Then only your devices can reach the port at all, every connection is
> encrypted end to end, and a device without the root certificate cannot be tricked by a look-alike
> server. The SSH tunnel is the equally safe choice for a single laptop.
>
> **Do not use it over public or untrusted Wi-Fi without that root certificate.** On a hotel, cafe,
> airport or office network, a plain `--host 0.0.0.0` instance or a browser that clicked through a
> certificate warning can be intercepted. With the VPN or tunnel up and the root certificate
> installed, an untrusted network underneath does not matter.
>
> The sign-in, lockout and origin checks are a second lock, not a reason to open the door. There are
> exactly three supported ways in.

Examples below use a server called `myhost` (LAN address 192.168.1.10) and the user `me`.

### 1. Home LAN over HTTPS with a `.local` hostname

For devices on your own trusted LAN. The UI serves HTTPS with a certificate for the machine's
hostname and answers only by name, never by IP address, so every browser validates the certificate.

```sh
./make-cert.sh myhost           # mkcert certificate for myhost, myhost.local, localhost, the LAN IP
./run.sh --host :: --cert ~/.config/agent-master/lan-cert.pem --key ~/.config/agent-master/lan-key.pem \
         --allowed-host myhost --allowed-host myhost.local
```

`.local` names are multicast DNS, so the server must announce itself: install and start
avahi (`sudo apt install avahi-daemon && sudo systemctl enable --now avahi-daemon`). macOS, iOS,
Android and Windows 10+ resolve `.local` out of the box; Linux laptops need `libnss-mdns`. Most
routers also resolve the bare DHCP hostname `myhost`. Then open `https://myhost.local:3000/`.
Requests by IP get `403 use the hostname`. Import the root certificate
that `make-cert.sh` prints on each device to silence the browser warning (macOS keychain, Windows
trusted roots, iOS profile, Android CA certificate); accepting the warning once still gives an
encrypted connection. Without client setup at all: a Let's Encrypt certificate through DNS-01 (Caddy
with `reverse_proxy 127.0.0.1:3000` in front of the UI on `--behind-proxy`), or `tailscale cert`.

### 2. SSH tunnel (recommended when travelling)

Nothing listens on the network; the only way in is your SSH key.

```sh
./run.sh --tunnel-only                              # on the server
ssh -N -L 3000:127.0.0.1:3000 me@myhost             # on the laptop
```

Then open http://127.0.0.1:3000/ on the laptop. The same command works on the LAN
(`me@myhost.local`), over Tailscale (`me@myhost` with MagicDNS) or, if you must, to a single
forwarded SSH port on the internet. The browser talks to its own machine and the traffic
crosses the network only inside SSH, so no certificate is needed. `--tunnel-only` binds 127.0.0.1
whatever else is passed and refuses any request not addressed to localhost, even after a careless
restart with `--host 0.0.0.0`. Use keys only (`ssh-copy-id me@myhost`, then
`PasswordAuthentication no` in sshd), and an `~/.ssh/config` entry with
`LocalForward 3000 127.0.0.1:3000` so the tunnel is one command. Phones: any SSH app with key
support and port forwarding.

### 3. VPN: Tailscale or WireGuard

Put both machines on a private mesh and keep the UI off every other interface: keep the localhost
bind and tunnel over the tailnet (`ssh -L 3000:127.0.0.1:3000 me@<tailscale-name>`), or bind the UI
to the VPN interface only, `./run.sh --host "$(tailscale ip -4)"`. Tailscale authenticates every
device with your identity provider and encrypts end to end; `tailscale cert` adds a trusted
certificate for HTTPS. Any WireGuard setup works the same way. Do not use ngrok, Cloudflare Tunnel
or similar services: they publish the port on the internet, which is exactly what must not happen.

If the UI was ever exposed by mistake: `./run.sh --reset-password`, sign out everywhere, and check
`~/.config/agent-master/events.db` for prompts you did not send.

### 4. Make the LAN traffic uninterceptable

The three access modes above give you an encrypted channel. The steps below turn a **casual**
encrypted channel into one that a neighbour on your Wi-Fi, a guest on the office LAN, or a
compromised router **cannot** MITM, downgrade or read. Layer them; each is small on its own, and
together they close every commonly-exploited hole.

**1. Install the mkcert root CA on every client that will connect.**
`make-cert.sh` uses [mkcert](https://github.com/FiloSottile/mkcert) to sign a leaf certificate for
your hostname with a private root CA that lives only on the machine you ran mkcert on. As long as
that root is *not* trusted on the client, browsers still show a warning and a determined attacker
can substitute their own cert. Once the root is trusted, the browser refuses **any** cert not
signed by it - no warning bypass, no MITM. Where the root lives and how to install it on each
device:

- Find the root file: run `mkcert -CAROOT` on the server; the CA lives at `<that>/rootCA.pem`.
  `make-cert.sh` also prints the exact path each time it runs. A copy is in this repo at
  `agent-master-rootCA.pem` for convenience - replace with your own.
- **macOS** (Safari, Chrome, Edge): `sudo security add-trusted-cert -d -r trustRoot -k \
  /Library/Keychains/System.keychain rootCA.pem`, or open Keychain Access → System → File → Import
  → mark "Always Trust". Firefox uses its own store; `mkcert -install` sets it if run on the client.
- **Windows** (Edge, Chrome, IE): `certutil -addstore -f "ROOT" rootCA.pem` in an elevated
  PowerShell. Firefox: about:preferences → Certificates → Import → tick "websites".
- **iOS/iPadOS**: AirDrop or email the `rootCA.pem` to the device, tap it, install the profile,
  then Settings → General → About → Certificate Trust Settings → toggle it on.
- **Android**: Settings → Security → Encryption & credentials → Install a certificate → CA
  certificate → pick the file. On Android 7+, only user-installed CAs work for browsers by default;
  apps trust it only if they opt in, which is fine for Agent-Master (browser only).
- **Linux, system-wide**: `sudo cp rootCA.pem /usr/local/share/ca-certificates/mkcert.crt && sudo
  update-ca-certificates` (Debian/Ubuntu/Kali) or drop it in `/etc/pki/ca-trust/source/anchors/`
  and run `sudo update-ca-trust` (Fedora/RHEL). Firefox on Linux still needs `mkcert -install` or
  a per-profile import via `certutil -A -d sql:$HOME/.mozilla/firefox/<profile>.default-release \
  -n mkcert -t 'C,,' -i rootCA.pem`.

Verify with `curl --cacert rootCA.pem https://myhost.local:3000/` - it must return the login page
with no `--insecure` flag. From then on, an attacker who wants to MITM must steal that CA's
**private key**, not just present any old certificate.

**2. Keep the CA private key off the running server.** mkcert stores the CA's private key next to
the root cert (`mkcert -CAROOT`). That key can sign a cert for **any** hostname, so it is worth
protecting the way you protect an SSH key. Copy `rootCA-key.pem` to an encrypted USB stick or a
password manager and delete it from the machine when not issuing new certs; keep only `rootCA.pem`
(the public part) around for reference. If that private key leaks, every device you installed the
root on trusts anything the attacker signs, until you rotate and re-install.

**3. Bind the server to one interface only.** `--host 0.0.0.0` listens on every NIC the machine has
- LAN, VPN, docker bridges, guest Wi-Fi. Prefer one of:

```sh
./run.sh --host 192.168.1.10 ...           # only the LAN NIC
./run.sh --host "$(tailscale ip -4)" ...   # only the Tailscale interface
./run.sh --tunnel-only                     # only 127.0.0.1; reach it via ssh -L
```

Anything on a different interface never sees the socket at all.

**4. Firewall the port even if you trust the LAN.** Belt-and-braces: only your subnet (or your VPN
CIDR) is allowed to talk to port 3000.

```sh
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
sudo ufw deny 3000
```

For Tailscale, allow only the tailnet: `sudo ufw allow in on tailscale0 to any port 3000`.

**5. HSTS is already on.** `app.py` sets `Strict-Transport-Security` when TLS is active, so once a
browser has visited over HTTPS, it refuses to downgrade to plain HTTP for that host within the
max-age window - an active attacker who blocks TLS can no longer trick the client into speaking
HTTP.

**6. Mutual TLS: require a client certificate as well.** This is the strongest option and it is
the one to reach for if the network you're on is genuinely hostile. Even a stolen Agent-Master
password is useless without a device certificate that only your laptop and phone hold. The setup
in ~15 minutes:

- **Mint a device certificate for every device** from the same mkcert root:
  ```sh
  mkcert -client -pkcs12 laptop.p12 you@laptop
  mkcert -client -pkcs12 phone.p12 you@phone
  # a random passphrase is printed; save it in your password manager
  ```
  `.p12` bundles the cert and its private key. Send each to the matching device (AirDrop,
  Signal, a USB stick).
- **Install the `.p12` on the device**: macOS → Keychain Access → import → Login keychain →
  password. Windows → double-click, "Current User", supply the passphrase. iOS → email or AirDrop
  → tap → install profile → passphrase → Settings → General → VPN & Device Management → verify.
  Android → Settings → Security → Encryption & credentials → Install a certificate → VPN & app
  user certificate. Linux Firefox → about:preferences → Certificates → Your Certificates → Import.
- **Terminate TLS in Caddy, and require the client cert**:
  ```caddy
  # /etc/caddy/Caddyfile (or ~/.config/caddy/Caddyfile in user mode)
  myhost.local:3443 {
      tls /home/you/.config/agent-master/lan-cert.pem /home/you/.config/agent-master/lan-key.pem {
          client_auth {
              mode                require_and_verify
              trusted_ca_cert_file /home/you/.local/share/mkcert/rootCA.pem
          }
      }
      reverse_proxy 127.0.0.1:3000
  }
  ```
  Start Caddy (`sudo systemctl enable --now caddy`) and run Agent-Master itself bound only to
  localhost so nothing else can bypass Caddy:
  ```sh
  ./run.sh --tunnel-only --behind-proxy
  ```
  Now `https://myhost.local:3443/` opens the login page only if the browser presents a valid
  client cert - no cert, no bytes past the TLS handshake. A password on top is the second lock.

**7. Better than trusting the LAN at all: put both machines on a mesh VPN.** [Tailscale] or
plain WireGuard give you an end-to-end encrypted overlay between just your devices, regardless of
what network they're joined to (home Wi-Fi, cafe, cellular). `tailscale cert` issues a real
Let's Encrypt certificate for a `*.ts.net` name, so there is no root-CA install step and no
`.local` mDNS broadcast on the LAN at all - a passive observer on your Wi-Fi sees only WireGuard
packets to a Tailscale relay. This is what to pick if you want zero client setup and the highest
default-safety.

[Tailscale]: https://tailscale.com
