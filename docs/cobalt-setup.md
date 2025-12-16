# Cobalt Setup Guide

This guide covers setting up [Cobalt](https://github.com/imputnet/cobalt) for automated YouTube video downloading.

## Overview

[Cobalt](https://github.com/imputnet/cobalt) handles video downloads from YouTube and other platforms. This setup uses **Cloudflare WARP** (via gluetun) to route traffic through trusted IPs with IPv6 support, bypassing YouTube's aggressive blocking.

**Requirements:**
- YouTube session cookies from your browser
- Cloudflare WARP credentials (WireGuard)
- Docker with IPv6 enabled
- ~10 minutes to set up

**Architecture:** The `cobalt-api` service runs through `gluetun_cobalt_api` which provides the Cloudflare WARP tunnel. See `docker-compose.yml` for the complete configuration.

## Cloudflare WARP Setup (Server Deployment)

**Guide:** [Hosting Cobalt with YouTube Support](https://hyper.lol/blog/7)

YouTube blocks automated downloads. We bypass this by routing Cobalt through **Cloudflare WARP** using WireGuard, which provides trusted IPs and required IPv6 connectivity.

### Quick Setup

**1. Enable IPv6 in Docker daemon:**
```bash
sudo tee /etc/docker/daemon.json > /dev/null <<EOF
{
  "ipv6": true,
  "fixed-cidr-v6": "fd00::/80"
}
EOF
sudo systemctl restart docker
```

**2. Create IPv6-enabled network:**
```bash
docker network create --driver bridge --ipv6 --subnet fd00:c0ba:105::/64 cobalt
```

**3. Generate WireGuard credentials:**
```bash
wget https://github.com/ViRb3/wgcf/releases/download/v2.2.29/wgcf_2.2.29_linux_amd64
chmod +x wgcf_2.2.29_linux_amd64
./wgcf_2.2.29_linux_amd64 register
./wgcf_2.2.29_linux_amd64 generate
cat wgcf-profile.conf
```

**4. Add to `.env` file:**
```bash
WIREGUARD_PUBLIC_KEY=<PublicKey from [Peer] section>
WIREGUARD_PRIVATE_KEY=<PrivateKey from [Interface] section>
WIREGUARD_ADDRESSES=<IPv4/32,IPv6/128 from Address line>
```

**Critical:** Include both IPv4 and IPv6 addresses from the `Address` line, separated by comma.

**5. Start and verify:**
```bash
docker-compose up -d
docker logs gluetun_cobalt_api | grep "Interface addresses" -A 3
docker exec cobalt-api wget -qO- ifconfig.me  # Should show Cloudflare IP
```

### Troubleshooting

If downloads fail with `error.api.fetch.critical`:
- Verify IPv6 in container: `docker exec gluetun_cobalt_api ip -6 addr show | grep 2606`
- Check Docker IPv6: `docker network inspect bridge | grep EnableIPv6`
- Ensure cookies are configured (see below)

## Setting Up YouTube Cookies

YouTube requires authenticated cookies. With Cloudflare WARP, requests appear to originate from Cloudflare's IP addresses, which YouTube generally treats more leniently.

**Try the simple method first:** Extract cookies from your local browser and test. Only if you get `error.api.youtube.login` errors, use the SSH proxy method below.

### Prerequisites

- A Google/YouTube account (free account works)
- Firefox, Chrome, or any modern browser with Developer Tools

### Step 1: Setup Browser Connection (Optional)

**For most users with Cloudflare WARP:** Skip this step and extract cookies normally from your local browser.

**If you encounter `error.api.youtube.login`**, create an SSH tunnel to extract cookies through your server's IP:

```bash
# Open SSH SOCKS proxy (keep this running)
ssh -D 8080 -N user@your-server-ip
```

Configure your browser to use the proxy:
- **Firefox:** Settings → Network Settings → Manual proxy → SOCKS Host: `localhost`, Port: `8080`
- **Chrome:** Launch with: `google-chrome --proxy-server="socks5://localhost:8080"`

### Step 2: Extract Cookies from Browser

This method requires **no browser extensions** - just built-in Developer Tools!

1. **Open Firefox** (or Chrome/Brave) and go to [youtube.com](https://youtube.com)
   - Sign in with your Google account
   - Browse a few videos to establish a session

2. **Open Developer Tools:**
   - Press `F12` (or right-click → Inspect)

3. **Go to the Network tab:**
   - Click the **Network** tab in Developer Tools

4. **Refresh the page:**
   - Press `F5` or `Ctrl+R` (Windows/Linux) / `Cmd+R` (Mac)

5. **Find the cookie header:**
   - Scroll to the very top of the network requests list
   - Click the first entry (usually `www.youtube.com` or the page itself)
   - On the right panel, ensure **Headers** is selected
   - Scroll down to the **Request Headers** section
   - Find the line that says `Cookie:`

6. **Copy the cookie value:**
   - Right-click the **value** (the long text after `Cookie:`)
   - Select **Copy Value**
   - This gives you a string like: `VISITOR_INFO1_LIVE=k8...; SID=Fe...; HSID=A6...`

**Visual guide:**
```
Network Tab → First Request → Headers → Request Headers
├── Accept: text/html...
├── Accept-Language: en-US...
├── Cookie: VISITOR_INFO1_LIVE=...; SID=...; HSID=...   ← COPY THIS VALUE!
├── Referer: https://www.youtube.com/
└── User-Agent: Mozilla/5.0...
```

**Tip:** The cookie string is usually very long (500+ characters). Make sure you copy the entire value!

### Step 3: Create cookies.json File

Create `secrets/cookies.json` in your project root:

```bash
mkdir -p secrets
nano secrets/cookies.json  # or use your preferred editor
```

**Required Format:**

Paste the raw cookie string you copied into this simple JSON format:

```json
{
    "youtube": [
        "VISITOR_INFO1_LIVE=k8...; SID=Fe...; HSID=A6...; SSID=...; APISID=...; SAPISID=..."
    ]
}
```

**Important:**
- **One long string:** Do not break the string into multiple lines. Keep it as one single line inside the quotes.
- **Just the value:** Do not include the word `Cookie:` at the start - only the actual cookie values (e.g., `SID=...;`).
- **Keep all cookies:** The string should contain all cookies from the browser request, separated by semicolons.

**Example of a valid cookies.json:**
```json
{
    "youtube": [
        "VISITOR_INFO1_LIVE=abc123xyz; CONSENT=YES+cb.20210328-17-p0.en+FX+123; PREF=f4=4000000&tz=America.New_York; SID=g.a000abcdef; HSID=Ahij12345; SSID=Aklm67890; APISID=nop123456/Aqrs789012; SAPISID=tuv345678/Awxy901234"
    ]
}
```

See [Cobalt's cookie documentation](https://github.com/imputnet/cobalt/blob/main/docs/examples/cookies.example.json) for reference.

### Step 4: Deploy and Restart

**For remote servers**, copy the cookies file:
```bash
scp secrets/cookies.json user@your-server:/path/to/opencouncil-tasks/secrets/
```

**Then restart Cobalt:**
```bash
docker compose restart cobalt-api

# Verify cookies loaded successfully
docker compose logs cobalt-api
```

**Look for this confirmation:**
```
[✓] cookies loaded successfully!
```

**If downloads work:** Great! The Cloudflare WARP setup is handling IP concerns.

**If you get `error.api.youtube.login`:** Go back to Step 1 and extract cookies through the SSH proxy to match your server's IP.

## Testing

### Test via CLI

Use the CLI to test a YouTube download. Since the app runs in Docker, execute the command inside the container:

```bash
# Test with a short YouTube video (using Docker)
docker compose run --rm app npm run cli -- download-ytv "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

### Check Cobalt Logs

Monitor Cobalt's output for errors:

```bash
docker compose logs -f cobalt-api
```

**Successful response indicators:**
- Status: `redirect` or `tunnel`
- Contains a valid video URL

**Error indicators:**
- `error.api.youtube.login` - Cookies invalid or IP mismatch (see Remote Server Setup)
- `rate_limit` - Too many requests (wait or use cookies)
- `content.video.unavailable` - Video restricted/private
- `fetch.fail` - Network or YouTube blocking issue

## Cookie Maintenance

### When to Update Cookies

- **Downloads start failing** - Cookies may have expired
- **After 6-12 months** - YouTube sessions typically expire
- **After password change** - Invalidates previous sessions
- **Rate limiting errors** - Fresh cookies can help

## Resources

- [Cobalt Documentation](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
- [Cobalt API Reference](https://github.com/imputnet/cobalt/blob/main/docs/api.md)
- [Cobalt Cookie Example](https://github.com/imputnet/cobalt/blob/main/docs/examples/cookies.example.json)
