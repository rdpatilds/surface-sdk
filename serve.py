# /// script
# requires-python = ">=3.12"
# ///
"""Static server for the theme bundle and rules.json with CORS, standing in for a CDN.

Canvas on port 3100 fetches rules.json from this origin, and a plain http.server sends no
Access-Control-Allow-Origin header, so that fetch would fail. A real CDN sends the header.
Run:  uv run serve.py --directory D:/Canvas/test/canvas/cplatform/nudges/theme --port 3101
"""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class CorsHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=3101)
    args = parser.parse_args()
    handler = functools.partial(CorsHandler, directory=args.directory)
    ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
