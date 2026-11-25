# Mycroft egress proxy — setup for the Mycroft admin

A tiny fixed-IP tunnel so the G2 glasses relay (on Railway, whose outbound IPs
change) can call Mycroft from one registered address.

- One file, `proxy.js`, Node.js 18+ core modules only (no `npm install`).
- Accepts only `CONNECT mycroftlive.mobilityae.com:443`, only with the shared
  secret, only over TLS. Everything else is refused.
- The relay's HTTPS session to Mycroft runs **inside** the tunnel: this machine
  never sees glasses tokens, questions or answers.
- Logs one JSON line per connection (time, client IP, outcome, bytes, duration).

## 1. Machine

Smallest Linux instance with a **fixed public IP** (e.g. EC2 t4g.nano/t3.nano +
Elastic IP in ap-south-1, next to Mycroft). Node.js 18 or newer.

Security group / firewall:
- **Inbound TCP 8443** from `0.0.0.0/0` (Railway's source IPs change; the secret
  and TLS protect it). Keep SSH restricted as usual.
- **Outbound TCP 443** to `mycroftlive.mobilityae.com`.

## 2. Install

```bash
sudo useradd --system --home /opt/mycroft-egress-proxy --shell /usr/sbin/nologin mycroftproxy
sudo mkdir -p /opt/mycroft-egress-proxy && cd /opt/mycroft-egress-proxy
sudo cp /path/to/proxy.js .

# Self-signed TLS certificate for THIS machine's fixed IP (replace 203.0.113.10)
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 1095 \
  -keyout proxy-key.pem -out proxy-cert.pem \
  -subj "/CN=mycroft-egress-proxy" -addext "subjectAltName=IP:203.0.113.10"

# Shared secret (48 random characters)
openssl rand -base64 36 | tr -d '\n' | sudo tee secret.txt >/dev/null

sudo chown -R mycroftproxy: /opt/mycroft-egress-proxy
sudo chmod 600 proxy-key.pem secret.txt
```

## 3. Run as a service

`/etc/systemd/system/mycroft-egress-proxy.service`:

```ini
[Unit]
Description=Mycroft egress proxy for the G2 glasses relay
After=network-online.target
Wants=network-online.target

[Service]
User=mycroftproxy
WorkingDirectory=/opt/mycroft-egress-proxy
ExecStart=/bin/sh -c 'PROXY_SECRET="$(cat secret.txt)" exec /usr/bin/node proxy.js'
Environment=PORT=8443
Environment=ALLOWED_TARGET=mycroftlive.mobilityae.com:443
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/opt/mycroft-egress-proxy

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mycroft-egress-proxy
journalctl -u mycroft-egress-proxy -f     # expect {"result":"listening","port":8443,…}
```

## 4. Quick check (from any machine)

```bash
# Wrong/no secret → 407; correct secret → "200 Connection Established"
curl -sv --proxy https://203.0.113.10:8443 --proxy-cacert proxy-cert.pem \
  --proxy-header "Proxy-Authorization: Bearer $(cat secret.txt)" \
  https://mycroftlive.mobilityae.com/ -o /dev/null 2>&1 | grep -E "Connection Established|HTTP/"
```

## 5. Hand over to the relay team

| Item | How |
|---|---|
| Fixed public IP | any channel (also register it with every glasses token) |
| `proxy-cert.pem` | any channel (public certificate) |
| `secret.txt` contents | **password manager only** |

The relay is configured with `MYCROFT_PROXY_URL=https://<ip>:8443`,
`MYCROFT_PROXY_SECRET` and `MYCROFT_PROXY_CA` (the certificate).

## 6. Operating

- **Rotate the secret:** write a new `secret.txt`, `systemctl restart`, give the new
  value to the relay team (brief interruption until Railway is updated).
- **Certificate** lasts 3 years; regenerate the same way and send the new cert.
- **Log outcomes:** `closed` (normal), `bad_auth` (wrong secret; 20 in 15 min from
  one IP → `blocked` for 15 min), `target_refused`, `upstream_unreachable`, `busy`
  (over 50 concurrent tunnels).
