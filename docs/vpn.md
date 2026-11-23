# VPN layout (optional)

> **You do not need this.** The phone reaches the PC and the ESP32 directly with
> ST1 (`docs/tunnel.md`), which needs no VPN client and no third-party service.
> This page is only for the case where you want to reach the machine from
> **outside your own Wi-Fi** — then something has to carry the packets, and a
> WireGuard tunnel or a tailnet is the honest way to do it. ST1 keeps working
> unchanged on top of it.

SENTINEL assumes the network is yours. Any tunnel that gives the phone an IP route
to the house works; these are the two that need the least fiddling.

## Option A — WireGuard on your router or a small VPS

```
phone   10.8.0.2  ──┐
ESP32   10.8.0.7  ──┼──► wg0 (router / VPS) ──► home LAN 192.168.1.0/24
PC      10.8.0.5  ──┘        AllowedIPs: 10.8.0.0/24, 192.168.1.0/24
```

`server.conf` fragment for the ESP32 peer:

``` ini
[Peer]
# ESP32 bridge
PublicKey = <esp32 public key>
AllowedIPs = 10.8.0.7/32
PersistentKeepalive = 25
```

The ESP32 needs the *server's* public key, its own private key, its assigned address
(`10.8.0.7`) and the endpoint `host:port` — all of which the setup portal asks for.
It cannot be the VPN server itself; it is a peer.

Then set the agent address in the portal to the PC's VPN address (`10.8.0.5`), and in
the phone app use `http://10.8.0.5:7878`.

## Option B — Tailscale / headscale

Install Tailscale on the PC and the phone; use the PC's `100.x.y.z` address. The ESP32
cannot run Tailscale, so for the ESP32 use *Option A* style WireGuard (Tailscale's
`tailscaled` can also terminate a plain WireGuard peer via a sidecar container) or keep
the ESP32 on the LAN and point it at the PC's **LAN** address while the phone uses the
tailnet address.

Mixed setups are fine: the phone only needs to reach either the agent or the ESP32.

## Option C — no VPN, LAN only

Works on the sofa, not from the office. The agent binds to all interfaces, so any device
on the same network can reach it — but it still needs the token. Never port-forward
7878 or 7879 to the internet: there is no rate limiting strong enough for that.

## Rules of thumb

1. **Do not expose the agent.** It is designed for a trusted network. If you need remote
   access, put a VPN in front of it, not a port forward.
2. **Keep the ESP32 on the tunnel** if you want to power the PC on from outside; a PC
   that is off cannot host a VPN client, but the ESP32 can be a peer permanently.
3. **Reserve addresses.** The agent stores the ESP32 device id, not its IP, but the phone
   stores the agent's address — a DHCP change means editing the connection once.
4. **Keep the clock sane.** WireGuard handshakes need the ESP32 to sync NTP; the firmware
   calls `configTime()` before bringing the tunnel up.
