{
  description = "opencouncil-tasks dev shell";

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
    };
}
