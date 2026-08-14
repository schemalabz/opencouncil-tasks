#!/usr/bin/env python3
"""Callback capture for async task endpoints. Appends each POST body to a
JSONL file; pair with an ngrok tunnel and pass the public URL as callbackUrl.

Usage: python3 cb-listener.py [logfile] [port]   (defaults: /tmp/callbacks.jsonl, 8787)
"""
import http.server, json, datetime, sys

LOG = sys.argv[1] if len(sys.argv) > 1 else "/tmp/callbacks.jsonl"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8787


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", errors="replace")
        with open(LOG, "a") as f:
            f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "path": self.path, "body": body}) + "\n")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
