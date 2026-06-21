#!/usr/bin/env python3
# 開発確認用の簡易静的サーバー（このディレクトリ配下を配信）
import http.server, socketserver, os
ROOT = os.path.dirname(os.path.abspath(__file__))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

if __name__ == "__main__":
    PORT = int(os.environ.get("PORT", "8766"))
    with socketserver.TCPServer(("127.0.0.1", PORT), H) as httpd:
        print(f"serving {ROOT} on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
