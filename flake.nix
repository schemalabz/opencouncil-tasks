{
  description = "opencouncil-tasks dev shell and preview deployment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs, nixpkgs-unstable }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system (import nixpkgs { inherit system; }) (import nixpkgs-unstable {
          inherit system;
          config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs-unstable.lib.getName pkg) [
            "ngrok"
          ];
        }));
    in {
      devShells = forAllSystems (_system: pkgs: pkgs-unstable: {
        default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs
            pkgs.nodePackages.npm
            pkgs.minio
            pkgs.minio-client
            pkgs.cachix
            pkgs-unstable.ngrok
          ];

          shellHook = ''
            echo ""
            echo "Inside opencouncil-tasks Nix dev shell"
            echo ""
            echo "  node $(node --version)"
            echo "  npm  $(npm --version)"
            echo ""
            echo "Run 'npm install' then 'npm test' to run tests."
          '';
        };
      });

      # Production build package
      packages = forAllSystems (_system: pkgs: pkgs-unstable: {
        opencouncil-tasks-prod = pkgs.buildNpmPackage {
          pname = "opencouncil-tasks-prod";
          version = "1.0.0";
          src = ./.;

          npmDepsHash = "sha256-Oe6gD1kemnX8qkGNtn9wjIIJLz5fzZ6Nn7be6mwHzaI=";

          # Handle peer dependency conflicts and skip postinstall scripts
          # (puppeteer downloads Chromium, ffmpeg-static downloads ffmpeg)
          # The preview server will use system-provided binaries instead
          npmFlags = [ "--legacy-peer-deps" "--ignore-scripts" ];

          # Build the TypeScript project
          buildPhase = ''
            npm run build
          '';

          # Install compiled output and dependencies
          installPhase = ''
            runHook preInstall

            mkdir -p $out
            cp -r dist $out/
            cp -r node_modules $out/
            cp package.json $out/

            # Create start script that sets working directory
            cat > $out/start.sh <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node dist/server.js
EOF
            chmod +x $out/start.sh

            runHook postInstall
          '';

          # Skip npm test during build
          doCheck = false;

          meta = {
            description = "OpenCouncil Tasks - Media processing pipeline service";
            mainProgram = "start.sh";
          };
        };
      });

      # NixOS module for preview deployments
      nixosModules.opencouncil-tasks-preview = { config, lib, pkgs, ... }:
        with lib;
        let
          cfg = config.services.opencouncil-tasks-preview;
        in {
          options.services.opencouncil-tasks-preview = {
            enable = mkEnableOption "OpenCouncil Tasks preview deployments";

            previewsDir = mkOption {
              type = types.path;
              default = "/var/lib/opencouncil-tasks-previews";
              description = "Directory to store preview instances";
            };

            user = mkOption {
              type = types.str;
              default = "opencouncil";
              description = "User to run preview services";
            };

            group = mkOption {
              type = types.str;
              default = "opencouncil";
              description = "Group to run preview services";
            };

            basePort = mkOption {
              type = types.int;
              default = 4000;
              description = "Base port for preview instances (PR number will be added)";
            };

            envFile = mkOption {
              type = types.nullOr types.path;
              default = null;
              description = ''
                Path to an environment file with shared runtime env vars
                (API keys, storage config, etc.). Loaded by systemd EnvironmentFile=.
              '';
            };

            previewDomain = mkOption {
              type = types.str;
              default = "tasks.opencouncil.gr";
              description = "Domain for preview subdomains (pr-N.<domain>)";
            };

            cachix = {
              enable = mkEnableOption "Cachix binary cache";
              cacheName = mkOption {
                type = types.str;
                default = "opencouncil";
                description = "Cachix cache name";
              };
              publicKey = mkOption {
                type = types.str;
                default = "opencouncil.cachix.org-1:D6DC/9ZvVTQ8OJkdXM86jny5dQWjGofNq9p6XqeCWwI=";
                description = "Cachix public key for signature verification";
              };
            };
          };

          config = mkIf cfg.enable {
            # Ensure the user/group exist (use mkDefault so opencouncil-preview module can override)
            users.users.${cfg.user} = {
              isSystemUser = mkDefault true;
              group = mkDefault cfg.group;
              home = mkDefault "/var/lib/opencouncil-previews";  # Shared home for both services
              createHome = mkDefault true;
              shell = mkDefault pkgs.bash;
            };

            users.groups.${cfg.group} = {};

            # Create the tasks-specific preview directory
            systemd.tmpfiles.rules = [
              "d ${cfg.previewsDir} 0755 ${cfg.user} ${cfg.group} -"
              "d /etc/caddy/conf.d 0755 caddy caddy -"
            ];

            # Nix settings (may already be set by opencouncil-preview, mkIf guards handle this)
            nix.settings.experimental-features = [ "nix-command" "flakes" ];
            nix.settings.trusted-users = [ "root" cfg.user ];

            # Cachix binary cache
            nix.settings.substituters = mkIf cfg.cachix.enable [
              "https://cache.nixos.org"
              "https://${cfg.cachix.cacheName}.cachix.org"
            ];
            nix.settings.trusted-public-keys = mkIf cfg.cachix.enable [
              "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
              cfg.cachix.publicKey
            ];

            # Note: We don't define a virtual host for the base domain (cfg.previewDomain)
            # because it may point to a different server. Preview subdomains (pr-N.*)
            # get their Caddy config added dynamically by opencouncil-tasks-preview-create.

            # Sudo rules for the deploy user
            security.sudo.extraRules = [
              {
                users = [ cfg.user ];
                commands = [
                  {
                    command = "${pkgs.systemd}/bin/systemctl start opencouncil-tasks-preview@*";
                    options = [ "NOPASSWD" ];
                  }
                  {
                    command = "${pkgs.systemd}/bin/systemctl stop opencouncil-tasks-preview@*";
                    options = [ "NOPASSWD" ];
                  }
                  {
                    command = "${pkgs.systemd}/bin/systemctl status opencouncil-tasks-preview@*";
                    options = [ "NOPASSWD" ];
                  }
                  {
                    command = "${pkgs.systemd}/bin/systemctl reload caddy";
                    options = [ "NOPASSWD" ];
                  }
                  {
                    command = "/run/current-system/sw/bin/opencouncil-tasks-preview-create";
                    options = [ "NOPASSWD" ];
                  }
                  {
                    command = "/run/current-system/sw/bin/opencouncil-tasks-preview-destroy";
                    options = [ "NOPASSWD" ];
                  }
                ];
              }
            ];

            # Template systemd service for preview instances.
            # Instance name (%i) is the port number (basePort + PR number).
            # Each PR has its own app at /var/lib/opencouncil-tasks-previews/pr-<N>/app
            # (a symlink to the nix store path, created by opencouncil-tasks-preview-create).
            systemd.services."opencouncil-tasks-preview@" = {
              description = "OpenCouncil Tasks preview instance on port %i";
              after = [ "network.target" ];

              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Group = cfg.group;
                Environment = [
                  "NODE_ENV=production"
                  "IS_PREVIEW=true"
                  "PORT=%i"
                ];
                # Load shared env vars (API keys, storage config, etc.) from file
                EnvironmentFile = mkIf (cfg.envFile != null) cfg.envFile;
                ExecStart = let
                  startScript = pkgs.writeShellScript "opencouncil-tasks-preview-start" ''
                    set -euo pipefail
                    PORT="$1"
                    PR_NUM=$((PORT - ${toString cfg.basePort}))
                    PR_DIR="${cfg.previewsDir}/pr-$PR_NUM"
                    APP_DIR="$PR_DIR/app"

                    if [ ! -L "$APP_DIR" ] && [ ! -d "$APP_DIR" ]; then
                      echo "Error: app not found at $APP_DIR" >&2
                      exit 1
                    fi

                    # Set preview-specific environment variables
                    export PUBLIC_URL="https://pr-$PR_NUM.${cfg.previewDomain}"
                    export PR_NUMBER="$PR_NUM"
                    export DATA_DIR="$PR_DIR/data"
                    mkdir -p "$DATA_DIR"

                    # Use system binaries (ffmpeg-static download was skipped in Nix build)
                    export FFMPEG_BIN_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
                    export YTDLP_BIN_PATH="${pkgs.yt-dlp}/bin/yt-dlp"
                    export PATH="${pkgs.ffmpeg}/bin:${pkgs.yt-dlp}/bin:$PATH"

                    cd "$APP_DIR"
                    exec ${pkgs.nodejs}/bin/node dist/server.js
                  '';
                in "${startScript} %i";
                Restart = "on-failure";
                RestartSec = "5s";

                # Security hardening
                NoNewPrivileges = true;
                PrivateTmp = true;
                ProtectHome = true;
                ReadWritePaths = [ cfg.previewsDir ];
              };
            };

            environment.systemPackages = [
              # Utility packages
              pkgs.git
              pkgs.cachix
              pkgs.curl
              pkgs.jq

              # Preview create script
              (pkgs.writeShellScriptBin "opencouncil-tasks-preview-create" ''
                set -euo pipefail

                if [ $# -ne 2 ]; then
                  echo "Usage: opencouncil-tasks-preview-create <pr-number> <nix-store-path>" >&2
                  exit 1
                fi

                pr_num="$1"
                store_path="$2"
                port=$((${toString cfg.basePort} + pr_num))
                pr_dir="${cfg.previewsDir}/pr-$pr_num"

                # Fetch the store path from Cachix (or other configured substituters) if not already local
                if [ ! -d "$store_path" ]; then
                  echo "Fetching $store_path from binary cache..."
                  nix-store --realise "$store_path" || {
                    echo "Error: could not fetch store path: $store_path" >&2
                    exit 1
                  }
                fi

                # Create per-PR directory and symlink to the build
                mkdir -p "$pr_dir"
                ln -sfn "$store_path" "$pr_dir/app"
                chown -R ${cfg.user}:${cfg.group} "$pr_dir"

                echo "Creating preview for PR #$pr_num on port $port"
                echo "  App: $store_path"

                # Stop existing service if running, then start fresh
                systemctl stop "opencouncil-tasks-preview@$port" 2>/dev/null || true
                systemctl start "opencouncil-tasks-preview@$port"

                # Add Caddy config for this preview
                config_file="/etc/caddy/conf.d/tasks-pr-$pr_num.conf"
                mkdir -p /etc/caddy/conf.d

                cat > "$config_file" <<CADDYEOF
pr-$pr_num.${cfg.previewDomain} {
  reverse_proxy localhost:$port {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }
}
CADDYEOF

                echo "Added Caddy config at $config_file"
                systemctl reload caddy

                echo ""
                echo "Preview created successfully"
                echo "  Local: http://localhost:$port"
                echo "  Public: https://pr-$pr_num.${cfg.previewDomain}"
                echo "  Service: opencouncil-tasks-preview@$port"
              '')

              # Preview destroy script
              (pkgs.writeShellScriptBin "opencouncil-tasks-preview-destroy" ''
                set -euo pipefail

                if [ $# -ne 1 ]; then
                  echo "Usage: opencouncil-tasks-preview-destroy <pr-number>" >&2
                  exit 1
                fi

                pr_num="$1"
                port=$((${toString cfg.basePort} + pr_num))
                pr_dir="${cfg.previewsDir}/pr-$pr_num"

                echo "Destroying preview for PR #$pr_num (port $port)"

                # Stop service
                systemctl stop "opencouncil-tasks-preview@$port" || true

                # Remove per-PR directory
                if [ -d "$pr_dir" ]; then
                  rm -rf "$pr_dir"
                fi

                # Remove Caddy config
                config_file="/etc/caddy/conf.d/tasks-pr-$pr_num.conf"
                if [ -f "$config_file" ]; then
                  rm "$config_file"
                  echo "Removed Caddy config"
                  systemctl reload caddy
                fi

                echo "Preview destroyed"
              '')

              # Preview list script
              (pkgs.writeShellScriptBin "opencouncil-tasks-preview-list" ''
                set -euo pipefail

                echo "Active opencouncil-tasks preview instances:"
                echo ""
                systemctl list-units "opencouncil-tasks-preview@*" --all --no-pager
                echo ""
                echo "Deployed builds:"
                for pr_dir in ${cfg.previewsDir}/pr-*; do
                  if [ -d "$pr_dir" ]; then
                    pr_name="$(basename "$pr_dir")"
                    app_link="$pr_dir/app"
                    if [ -L "$app_link" ]; then
                      echo "  $pr_name -> $(readlink "$app_link")"
                    else
                      echo "  $pr_name (no app symlink)"
                    fi
                  fi
                done
              '')

              # Preview logs script
              (pkgs.writeShellScriptBin "opencouncil-tasks-preview-logs" ''
                set -euo pipefail

                if [ $# -lt 1 ]; then
                  echo "Usage: opencouncil-tasks-preview-logs <pr-number> [journalctl args...]" >&2
                  echo "Example: opencouncil-tasks-preview-logs 123" >&2
                  echo "Example: opencouncil-tasks-preview-logs 123 -n 50" >&2
                  exit 1
                fi

                pr_num="$1"
                shift
                port=$((${toString cfg.basePort} + pr_num))

                # Default to follow mode if no extra args given
                if [ $# -eq 0 ]; then
                  exec journalctl -u "opencouncil-tasks-preview@$port" -f
                else
                  exec journalctl -u "opencouncil-tasks-preview@$port" "$@"
                fi
              '')
            ];
          };
        };
    };
}
