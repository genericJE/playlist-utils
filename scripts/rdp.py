#!/usr/bin/env python3
"""Minimal Firefox Remote Debugging Protocol client.

Enough of the protocol to list tabs and evaluate JavaScript in one, so the
extension's real behaviour on the phone can be read back instead of guessed
at from screenshots.
"""
import json
import socket
import sys


class RDP:
    def __init__(self, host="127.0.0.1", port=6000, timeout=25):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.buf = b""
        self.pending = []
        self.read_packet()  # server greeting

    def send(self, obj):
        raw = json.dumps(obj).encode()
        self.sock.sendall(str(len(raw)).encode() + b":" + raw)

    def read_packet(self):
        while True:
            if b":" in self.buf:
                head, rest = self.buf.split(b":", 1)
                if head.isdigit():
                    n = int(head)
                    if len(rest) >= n:
                        self.buf = rest[n:]
                        return json.loads(rest[:n].decode())
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("connection closed")
            self.buf += chunk

    def request(self, obj, match=None):
        """Send a request and return the first packet matching `match`."""
        self.send(obj)
        for _ in range(400):
            pkt = self.read_packet()
            if match is None:
                if pkt.get("from") == obj.get("to"):
                    return pkt
            elif match(pkt):
                return pkt
            self.pending.append(pkt)
        raise RuntimeError("no matching reply")

    def tabs(self):
        reply = self.request({"to": "root", "type": "listTabs"},
                             match=lambda p: "tabs" in p)
        return reply["tabs"]

    def console_for(self, tab):
        """Resolve a tab entry to a console actor across protocol generations."""
        if tab.get("consoleActor"):
            return tab["consoleActor"]
        actor = tab.get("actor")
        target = self.request({"to": actor, "type": "getTarget"},
                              match=lambda p: "frame" in p or "consoleActor" in p)
        frame = target.get("frame", target)
        return frame.get("consoleActor")

    def eval(self, console, text):
        reply = self.request(
            {"to": console, "type": "evaluateJSAsync", "text": text,
             "mapped": {"await": True}},
            match=lambda p: p.get("type") == "evaluationResult" or "result" in p,
        )
        return reply


def main():
    expr = sys.stdin.read()
    rdp = RDP(port=int(sys.argv[1]) if len(sys.argv) > 1 else 6000)
    tabs = rdp.tabs()
    want = sys.argv[2] if len(sys.argv) > 2 else "youtube.com"
    matches = [t for t in tabs if want in (t.get("url") or "")]
    # The focused tab is the one being driven, so prefer it.
    target = next((t for t in matches if t.get("selected")), None) or (matches[0] if matches else None)
    if target is None:
        print(json.dumps({"error": "no youtube tab",
                          "tabs": [t.get("url") for t in tabs]}))
        return
    console = rdp.console_for(target)
    if not console:
        print(json.dumps({"error": "no console actor", "tab": target.get("url")}))
        return
    reply = rdp.eval(console, expr)
    result = reply.get("result")
    if isinstance(result, dict) and result.get("type") == "undefined":
        result = None
    print(json.dumps({"url": target.get("url"), "result": result,
                      "exception": reply.get("exceptionMessage")}, indent=1))


if __name__ == "__main__":
    main()
