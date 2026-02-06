# Preview Deployments Setup Guide

This guide walks through setting up PR preview deployments for opencouncil-tasks. Previews are deployed to `https://pr-N.tasks.opencouncil.gr` when a PR is opened against `main`.

## Prerequisites

Before starting, ensure you have:

- [ ] Access to the `schemalabz/opencouncil-tasks` GitHub repository (admin)
- [ ] Access to the preview droplet (SSH as root)
- [ ] Access to DNS management for `opencouncil.gr`
- [ ] Cachix account with access to the `opencouncil` cache

## Architecture Overview

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────────┐
│   GitHub PR     │────▶│   GitHub     │────▶│    Cachix           │
│   (opened)      │     │   Actions    │     │    (binary cache)   │
└─────────────────┘     └──────────────┘     └─────────────────────┘
                               │                        │
                               │ SSH deploy             │ nix-store --realise
                               ▼                        ▼
                        ┌──────────────────────────────────────────┐
                        │           Preview Droplet                 │
                        │  ┌────────────────────────────────────┐  │
                        │  │ Caddy (reverse proxy + TLS)        │  │
                        │  │   pr-N.tasks.opencouncil.gr:443    │  │
                        │  └─────────────────┬──────────────────┘  │
                        │                    │                      │
                        │                    ▼                      │
                        │  ┌────────────────────────────────────┐  │
                        │  │ systemd: opencouncil-tasks-preview@│  │
                        │  │   localhost:4000+N                 │  │
                        │  └────────────────────────────────────┘  │
                        └──────────────────────────────────────────┘
```

---

## Step 1: Configure DNS

Add a wildcard DNS A record pointing to the preview droplet.

**Action:** In your DNS provider (e.g., Cloudflare, DigitalOcean DNS), create:

```
Type: A
Name: *.tasks
Value: <DROPLET_IP_ADDRESS>
TTL: 300 (or auto)
```

**Verification:**
```bash
# Wait a few minutes for DNS propagation, then:
dig +short test.tasks.opencouncil.gr
# Should return: <DROPLET_IP_ADDRESS>
```

---

## Step 2: Configure GitHub Repository

### 2.1 Create the Preview Environment

1. Go to repository **Settings** → **Environments**
2. Click **New environment**
3. Name: `preview`
4. Click **Configure environment**

### 2.2 Add Repository Secrets

Go to **Settings** → **Secrets and variables** → **Actions** → **Secrets tab**

Add these secrets (click "New repository secret" for each):

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `CACHIX_AUTH_TOKEN` | Cachix authentication token | [cachix.org](https://cachix.org) → Settings → Auth Tokens |
| `PREVIEW_DEPLOY_SSH_KEY` | SSH private key for droplet access | Generate with `ssh-keygen -t ed25519 -C "github-preview-deploy"` |
| `PREVIEW_HOST` | Droplet IP address | Your droplet's public IP |
| `PREVIEW_USER` | SSH username (optional, defaults to `opencouncil`) | Usually `opencouncil` |

**Generate SSH key pair:**
```bash
# On your local machine
ssh-keygen -t ed25519 -C "github-preview-deploy" -f preview-deploy-key -N ""

# Copy the PRIVATE key content to PREVIEW_DEPLOY_SSH_KEY secret
cat preview-deploy-key

# You'll add the PUBLIC key to the droplet in Step 3
cat preview-deploy-key.pub
```

**Verification:**
- Go to Settings → Secrets → Actions
- You should see: `CACHIX_AUTH_TOKEN`, `PREVIEW_DEPLOY_SSH_KEY`, `PREVIEW_HOST`

---

## Step 3: Configure the Preview Droplet

SSH into the droplet as root:
```bash
ssh root@<DROPLET_IP>
```

### 3.1 Add the Deploy SSH Key

Add the public key from Step 2.2 to the `opencouncil` user:

```bash
# Create user if it doesn't exist (the NixOS module will also create it)
useradd -m -s /bin/bash opencouncil || true

# Add the public key
mkdir -p /home/opencouncil/.ssh
echo "ssh-ed25519 AAAA... github-preview-deploy" >> /home/opencouncil/.ssh/authorized_keys
chmod 700 /home/opencouncil/.ssh
chmod 600 /home/opencouncil/.ssh/authorized_keys
chown -R opencouncil:opencouncil /home/opencouncil/.ssh
```

### 3.2 Update the NixOS Flake

Edit `/etc/nixos/flake.nix`:

```bash
nano /etc/nixos/flake.nix
```

Update it to include opencouncil-tasks:

```nix
{
  description = "Preview server configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    opencouncil.url = "github:schemalabz/opencouncil";
    opencouncil-tasks.url = "github:schemalabz/opencouncil-tasks";
  };

  outputs = { self, nixpkgs, opencouncil, opencouncil-tasks, ... }: {
    nixosConfigurations.preview = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        opencouncil.nixosModules.opencouncil-preview
        opencouncil-tasks.nixosModules.opencouncil-tasks-preview
        ./configuration.nix
      ];
    };
  };
}
```

### 3.3 Update the NixOS Configuration

Edit `/etc/nixos/configuration.nix`:

```bash
nano /etc/nixos/configuration.nix
```

Add the opencouncil-tasks-preview service configuration:

```nix
{ config, pkgs, ... }:

{
  # ... existing configuration ...

  # Caddy web server (if not already configured)
  services.caddy.enable = true;

  # OpenCouncil main app previews (port 3000+N)
  services.opencouncil-preview = {
    enable = true;
    envFile = "/var/lib/opencouncil-previews/.env";
    cachix.enable = true;
  };

  # OpenCouncil Tasks API previews (port 4000+N)
  services.opencouncil-tasks-preview = {
    enable = true;
    envFile = "/var/lib/opencouncil-tasks-previews/.env";
    previewDomain = "tasks.opencouncil.gr";
    cachix.enable = true;
  };

  # ... rest of configuration ...
}
```

### 3.4 Create the Environment File

Create the directory and environment file:

```bash
mkdir -p /var/lib/opencouncil-tasks-previews
nano /var/lib/opencouncil-tasks-previews/.env
```

Add the required environment variables:

```env
# =============================================================================
# Authentication
# =============================================================================
# API tokens for authenticating requests (JSON array format)
# Use the same token when connecting opencouncil preview to this tasks preview
API_TOKENS=["your-preview-api-token-here"]

# =============================================================================
# Storage (DigitalOcean Spaces)
# =============================================================================
DO_SPACES_KEY=your-spaces-key
DO_SPACES_SECRET=your-spaces-secret
DO_SPACES_ENDPOINT=https://ams3.digitaloceanspaces.com
DO_SPACES_BUCKET=your-bucket-name
CDN_BASE_URL=https://your-cdn-url.com

# =============================================================================
# External Services
# =============================================================================
GLADIA_API_KEY=your-gladia-key
PYANNOTE_DIARIZE_API_URL=https://your-pyannote-url
PYANNOTE_API_TOKEN=your-pyannote-token
MUX_TOKEN_ID=your-mux-token-id
MUX_TOKEN_SECRET=your-mux-token-secret
ANTHROPIC_API_KEY=your-anthropic-key

# =============================================================================
# CORS
# =============================================================================
CORS_ORIGINS_ALLOWED=https://opencouncil.gr,https://*.preview.opencouncil.gr,https://*.tasks.opencouncil.gr
```

Set proper permissions:

```bash
chown -R opencouncil:opencouncil /var/lib/opencouncil-tasks-previews
chmod 600 /var/lib/opencouncil-tasks-previews/.env
```

### 3.5 Apply the Configuration

```bash
# Update flake inputs to get latest opencouncil-tasks
nix flake update opencouncil-tasks --flake /etc/nixos

# Rebuild and switch to new configuration
nixos-rebuild switch --flake /etc/nixos#preview
```

**Verification:**
```bash
# Check that the management scripts are available
which opencouncil-tasks-preview-create
which opencouncil-tasks-preview-destroy
which opencouncil-tasks-preview-list

# Check Caddy is running
systemctl status caddy
```

---

## Step 4: Verify the Setup

### 4.1 Test SSH Access from GitHub Actions

From your local machine (simulating GitHub Actions):

```bash
ssh -i preview-deploy-key opencouncil@<DROPLET_IP> "echo 'SSH works'"
```

### 4.2 Test Manual Preview Creation

Build and deploy a test preview manually:

```bash
# On your local machine, in the opencouncil-tasks repo
nix build .#opencouncil-tasks-prod
cachix push opencouncil ./result
STORE_PATH=$(readlink ./result)
echo "Store path: $STORE_PATH"

# On the droplet (as opencouncil user)
ssh opencouncil@<DROPLET_IP>
sudo opencouncil-tasks-preview-create 999 <STORE_PATH>
```

### 4.3 Test the Preview

```bash
# Health check
curl https://pr-999.tasks.opencouncil.gr/health

# Should return JSON with status: "healthy"
```

### 4.4 Clean Up Test Preview

```bash
ssh opencouncil@<DROPLET_IP> "sudo opencouncil-tasks-preview-destroy 999"
```

---

## Step 5: Test with a Real PR

1. Create a new branch and make a small change
2. Open a PR against `main`
3. Watch the GitHub Actions workflow run
4. Check the PR comment for the preview URL
5. Test the preview
6. Close/merge the PR and verify cleanup

---

## Connecting OpenCouncil Preview to Tasks Preview

When testing both services together:

1. Deploy opencouncil preview at `https://pr-N.preview.opencouncil.gr`
2. Deploy opencouncil-tasks preview at `https://pr-M.tasks.opencouncil.gr`

Configure the opencouncil preview's environment to use the tasks preview:

```env
TASKS_API_URL=https://pr-M.tasks.opencouncil.gr
TASKS_API_TOKEN=your-preview-api-token-here  # Same as in tasks .env
```

---

## Troubleshooting

### Preview not deploying

1. Check GitHub Actions logs for the workflow run
2. Verify secrets are configured correctly
3. Test SSH access manually

### Preview not accessible

```bash
# On droplet, check service status
systemctl status opencouncil-tasks-preview@4123  # For PR #123

# Check logs
journalctl -u opencouncil-tasks-preview@4123 -n 50

# Check Caddy config exists
cat /etc/caddy/conf.d/tasks-pr-123.conf

# Check Caddy status
systemctl status caddy
```

### Health check failing

```bash
# Test locally on droplet
curl http://localhost:4123/health

# Check environment variables are loaded
systemctl show opencouncil-tasks-preview@4123 --property=Environment
```

### Build not found on Cachix

```bash
# On droplet, try fetching manually
nix-store --realise /nix/store/...-opencouncil-tasks-prod-1.0.0

# Check Cachix is configured
cat /etc/nix/nix.conf | grep substituters
```

---

## Management Commands

All commands run on the droplet:

```bash
# List active previews
opencouncil-tasks-preview-list

# View logs for PR #123
opencouncil-tasks-preview-logs 123

# View last 100 lines
opencouncil-tasks-preview-logs 123 -n 100

# Manually create preview
sudo opencouncil-tasks-preview-create <PR_NUM> <NIX_STORE_PATH>

# Manually destroy preview
sudo opencouncil-tasks-preview-destroy <PR_NUM>

# Check specific service
systemctl status opencouncil-tasks-preview@4123  # For PR #123
```

---

## Port Allocation

To avoid conflicts:
- **opencouncil** (main app): base port 3000 (PR #N → port 3000+N)
- **opencouncil-tasks**: base port 4000 (PR #N → port 4000+N)
