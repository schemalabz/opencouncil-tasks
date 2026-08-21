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
            # Deno from unstable: yt-dlp's EJS runtime needs Deno >= 2.3.0;
            # nixpkgs-24.11 ships 2.1.4, which yt-dlp rejects as unsupported.
            pkgs-unstable.deno
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

          # importNpmLock fetches each package using the integrity hashes
          # already in package-lock.json, so there is no aggregate npmDepsHash
          # to keep in sync when the lockfile changes (e.g. dependabot bumps).
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

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

            # Create start script that sets the working directory and pins the
            # full runtime to THIS flake's nixpkgs — the app runs on the
            # toolchain that built it, wherever it's deployed. yt-dlp and its
            # EJS JavaScript runtime (deno >= 2.3.0) come from unstable:
            # nixpkgs-24.11 ships deno 2.1.4, which yt-dlp rejects.
            cat > $out/start.sh <<'EOF'
#!${pkgs.runtimeShell}
cd "$(dirname "$0")"
export FFMPEG_BIN_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
export YTDLP_BIN_PATH="${pkgs-unstable.yt-dlp}/bin/yt-dlp"
export PATH="${pkgs.ffmpeg}/bin:${pkgs-unstable.yt-dlp}/bin:${pkgs-unstable.deno}/bin:''$PATH"
exec ${pkgs.nodejs}/bin/node dist/server.js
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

      # Preview deployment config for the generic pr-previews module
      # (github:schemalabz/pr-previews). Consumed by the host as
      #   services.pr-previews.projects = opencouncil-tasks.previews // ...;
      previews.opencouncil-tasks = {
        hostPattern = "pr-@id@.tasks.opencouncil.dev";
        # Keep the old preview URLs answering with 301s during the move;
        # drop once the migration settles.
        redirectFrom = [ "pr-@id@.tasks.opencouncil.gr" ];
        basePort = 4000;

        cachix = {
          enable = true;
          name = "opencouncil";
          publicKey = "opencouncil.cachix.org-1:D6DC/9ZvVTQ8OJkdXM86jny5dQWjGofNq9p6XqeCWwI=";
        };

        # Host-side env composition only; the app's own start.sh owns the
        # runtime (node/ffmpeg/yt-dlp pinned at build). Runtime-ownership
        # rule: see pr-previews README.
        startScript = _: ctx: ''
          export PUBLIC_URL="https://${ctx.host}"
          export PR_NUMBER="$PR_NUM"
          export DATA_DIR="$PR_DIR/data"
          mkdir -p "$DATA_DIR"

          # Deno is yt-dlp's JavaScript runtime for YouTube extraction;
          # DENO_DIR must be writable by the service user.
          export DENO_DIR="$PR_DIR/.deno"
          mkdir -p "$DENO_DIR"

          exec "$APP_DIR/start.sh"
        '';
      };
    };
}
