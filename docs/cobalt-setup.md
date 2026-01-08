# Cobalt Setup Guide

This guide covers setting up [Cobalt](https://github.com/imputnet/cobalt) for automated YouTube video downloading.

## Overview

[Cobalt](https://github.com/imputnet/cobalt) handles video downloads from YouTube and other platforms. This setup uses a **residential proxy** to route traffic through trusted residential IPs, bypassing YouTube's aggressive blocking.

**Requirements:**
- Residential proxy credentials (HTTP/HTTPS or SOCKS5)
- ~5 minutes to set up

**Architecture:** 
1. **cobalt-api** uses `HTTP_PROXY` environment variable to route traffic to `proxy-forwarder:3128`
2. **proxy-forwarder** (Squid) receives the traffic and forwards it to your residential proxy (configured in `squid.conf`)
3. Your **residential proxy** routes traffic through residential IPs to YouTube

This three-tier setup ensures all Cobalt traffic appears to originate from residential IPs. See `docker-compose.yml` for the complete configuration.

**Note:** While HTTP_PROXY environment variables can be unreliable in some Node.js applications, we've verified this approach works with Cobalt by monitoring the proxy logs (see verification steps below).

## Residential Proxy Setup

YouTube blocks automated downloads from datacenter IPs. Using a residential proxy provides:
- **Residential IP addresses** - Trusted by YouTube
- **Geographic flexibility** - Route through different regions
- **No IPv6 complexity** - Works with standard HTTP/HTTPS
- **Reliable setup** - Extract default Squid config and add your proxy credentials

**Important notes:**
- We extract the default Squid config from the container and add residential proxy forwarding to it
- This approach works reliably on Digital Ocean droplets and other VPS providers

### Quick Setup

**1. Configure residential proxy:**

Your residential proxy provider should give you credentials in this format:
```
username:password@proxy-host:port
```

```bash
# 1. Use a temporary container to extract default Squid config
docker run --rm --name temp-squid -d ubuntu/squid
sleep 3

# 2. Extract the default config
docker exec temp-squid cat /etc/squid/squid.conf > squid.conf

# 3. Stop the temporary container
docker stop temp-squid

# 4. Add your residential proxy configuration to the end
cat >> squid.conf << 'EOF'

# Residential proxy configuration
cache_peer YOUR_PROXY_HOST parent YOUR_PROXY_PORT 0 no-query no-digest no-netdb-exchange connect-fail-limit=0 connect-timeout=1 default login=YOUR_USERNAME:YOUR_PASSWORD
never_direct allow all
EOF

# 5. Edit the file to add your actual credentials
vim squid.conf  # Replace YOUR_PROXY_HOST, YOUR_PROXY_PORT, YOUR_USERNAME, YOUR_PASSWORD
```

**Note:** The `squid.conf` file is in `.gitignore` to protect your credentials.

**2. Start services:**
```bash
docker compose up -d cobalt-api
```

This will automatically start both `proxy-forwarder` (dependency) and `cobalt-api`.

**3. Verify proxy is working:**

```bash
# Method 1: Check services are running
docker compose ps proxy-forwarder cobalt-api
# Both should show "running" status

# Method 2: Compare IPs (quick verification)
echo "Your server IP: $(curl -s https://api.ipify.org)"
echo "Residential proxy IP: $(curl -x http://localhost:3128 -s https://api.ipify.org)"
# These should be DIFFERENT - proxy IP should be residential
# If this returns nothing, see troubleshooting below

# Method 3: Make a test download and check proxy logs
docker compose run --rm app npm run cli -- download-ytv "https://www.youtube.com/watch?v=jNQXAC9IVRw"

# Then check if the request went through the proxy
docker compose logs proxy-forwarder --tail 50 2>&1 | grep -v "WARN\[" | grep -E "(youtube|googlevideo)"
# Should show lines like:
# TCP_TUNNEL/200 CONNECT youtube.com:443 - FIRSTUP_PARENT/67.213.121.89
# TCP_TUNNEL/200 CONNECT googlevideo.com:443 - FIRSTUP_PARENT/67.213.121.89

```

**What to look for:**
- Proxy test should return a **residential IP** (not your server's IP)
- Proxy logs should show `CONNECT youtube.com:443 - FIRSTUP_PARENT/...` indicating traffic is being forwarded
- The `FIRSTUP_PARENT` IP should be a residential IP from your proxy provider

### Troubleshooting

**If the proxy test returns nothing:**

```bash
# 1. Check if proxy-forwarder is running
docker compose ps proxy-forwarder
# Should show "running" status

# 2. Check proxy-forwarder logs for startup errors
docker compose logs proxy-forwarder | tail -30
# Look for "Accepting HTTP Socket connections" - means Squid started successfully

# 3. Check if squid.conf has syntax errors
docker compose logs proxy-forwarder | grep -i "error\|fatal"

# 4. Verify port 3128 is listening
docker exec proxy-forwarder netstat -tlnp | grep 3128
# Should show: tcp 0.0.0.0:3128

# 5. Test residential proxy directly (bypass Squid)
curl -x "http://username:password@proxy-host:port" https://api.ipify.org
# If this fails, your residential proxy credentials are wrong or proxy is down

# 6. Restart services
docker compose restart proxy-forwarder cobalt-api
```

**Other common issues:**

- **`error.api.fetch.critical`** - Proxy or network issue
  - Verify `squid.conf` has correct credentials (host, port, username, password)
  - Check proxy has available bandwidth/sessions with your provider
  - Restart services: `docker compose restart proxy-forwarder cobalt-api`

- **`error.api.youtube.login`** - YouTube authentication issue (check proxy logs and verify residential proxy is working)

- **Proxy forwarding but downloads fail** - Check cobalt-api logs: `docker compose logs cobalt-api | tail -50`

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
- `error.api.youtube.login` - YouTube authentication issue (residential proxy should handle this)
- `rate_limit` - Too many requests (wait, or check proxy rate limits)
- `content.video.unavailable` - Video restricted/private
- `fetch.fail` - Network, proxy, or YouTube blocking issue

## Resources

- [Cobalt Documentation](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
- [Cobalt API Reference](https://github.com/imputnet/cobalt/blob/main/docs/api.md)
- [Hosting Cobalt with YouTube Support using Cloudflare WARP](https://hyper.lol/blog/7) - Alternative approach we tried previously.
